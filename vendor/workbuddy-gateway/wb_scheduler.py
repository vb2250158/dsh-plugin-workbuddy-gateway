"""wb_scheduler.py —— 后台定时调度器 (Scheduler)

负责常驻后台自动执行：
1. Token 保活 (Keepalive)：定期检查 Token 剩余寿命，不足 2 小时自动调用 Refresh Token。
2. 每日签到 (Daily Checkin)：每日定时为所有国内版账号自动签到领积分。
3. 猫猫旅行与日常结算 (Cat Travel & Welfare)：自动派出猫猫旅行或领取归来奖励。
4. 状态持久化与看板展示：暴露状态、执行记录、支持手动立即触发与开关切换。
"""
import json
import os
import threading
import time
from wb_tasks import do_cat_travel
from wb_growth import GrowthCheckin


class Scheduler:
    def __init__(self, pool):
        self.pool = pool
        # 对齐 Sliverkiss/workbuddy2api 官方默认排程 (CST 24小时制)
        self.checkin_hours = [9, 21]     # 每日 09:00、21:00 签到
        self.travel_hours = [9, 21]      # 每日 09:00 派出、21:00 领奖闭环
        self.keepalive_hours = [22]      # 每日 22:00 集中 Token 保活检查
        self.cat_hours = [1]             # 每日 01:00 夜猫子专属任务
        self.all_hours = sorted(list(set(self.checkin_hours + self.travel_hours + self.keepalive_hours + self.cat_hours)))
        self.enabled = True
        self._stop_event = threading.Event()
        self._cycle_lock = threading.Lock()
        self._thread = None
        self.growth = GrowthCheckin(
            enabled=os.environ.get("WB_GROWTH_CHECKIN_ENABLED", "0") == "1",
            retry_seconds=int(os.environ.get("WB_GROWTH_CHECKIN_RETRY_SECONDS", "300")),
            max_checks=int(os.environ.get("WB_GROWTH_CHECKIN_MAX_CHECKS", "3")))
        self.last_run_time = None
        self.next_run_time = None
        self.logs = []
        self._calc_next_fire()

    def log(self, msg):
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        entry = f"[{ts}] {msg}"
        self.logs.append(entry)
        if len(self.logs) > 60:
            self.logs = self.logs[-60:]

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        self.log("后台定时调度器已启动")

    def stop(self):
        self._stop_event.set()
        self.log("后台定时调度器已暂停")

    def _run_loop(self):
        # 启动后先休眠 10 秒等待主服务就绪，然后执行初次检查
        if self._stop_event.wait(10):
            return
        try:
            if self.enabled:
                self._execute_cycle("启动初次初始化巡检")
        except Exception as exc:
            self.log(f"初次巡检异常: {exc}")

        while not self._stop_event.is_set():
            self._calc_next_fire()
            # 每 30 秒检查一次当前整点
            now = time.localtime()
            cur_hour = now.tm_hour
            cur_min = now.tm_min
            if self.enabled:
                # 到达设定的整点前 1 分钟内触发
                if cur_min == 0 and cur_hour in self.all_hours:
                    reason = f"整点排程命中 ({cur_hour}:00)"
                    try:
                        self._execute_cycle(reason)
                    except Exception as exc:
                        self.log(f"排程执行异常: {exc}")
                    self._stop_event.wait(65) # 避开当前这一分钟重复触发
                self._execute_growth()
            self._stop_event.wait(30)

    def _run_growth(self, acc):
        """Publish only confirmed activity as success; keep uncertain outcomes visible."""
        try:
            result = self.growth.run(acc, self._stop_event)
            if result:
                self.log(f"成长打卡 [{acc.uid[:8]}]: {result['status']} ({result['reason'] or result['date']})")
        except Exception as exc:
            self.log(f"成长打卡执行失败 [{acc.uid[:8]}]: {type(exc).__name__}")

    def _execute_growth(self):
        """Poll due growth checks without repeating billing or travel operations."""
        if self._stop_event.is_set() or not self._cycle_lock.acquire(blocking=False):
            return
        try:
            for acc in list(self.pool.accounts) if self.pool else []:
                self._run_growth(acc)
        finally:
            self._cycle_lock.release()

    def _calc_next_fire(self):
        now = time.localtime()
        cur_h = now.tm_hour
        next_h = None
        for h in self.all_hours:
            if h > cur_h or (h == cur_h and now.tm_min == 0 and now.tm_sec < 10):
                next_h = h
                break
        if next_h is not None:
            # 今天
            t_struct = time.struct_time((now.tm_year, now.tm_mon, now.tm_mday, next_h, 0, 0, 0, 0, -1))
        else:
            # 明天第一个小时
            t_tomorrow = time.time() + 86400
            now_tom = time.localtime(t_tomorrow)
            first_h = self.all_hours[0]
            t_struct = time.struct_time((now_tom.tm_year, now_tom.tm_mon, now_tom.tm_mday, first_h, 0, 0, 0, 0, -1))
        self.next_run_time = time.strftime("%Y-%m-%d %H:%M:%S", t_struct)

    def trigger_now(self):
        """手动立即触发一次调度检查。"""
        threading.Thread(target=self._execute_cycle, args=("手动立即触发",), daemon=True).start()
        return {"ok": True, "msg": "已触发后台调度执行"}

    def _execute_cycle(self, trigger_reason="周期巡检"):
        """Skip overlapping triggers; successful check-ins persist across restarts."""
        if self._stop_event.is_set() or not self._cycle_lock.acquire(blocking=False):
            return
        try:
            self._run_cycle(trigger_reason)
        finally:
            self._cycle_lock.release()

    def _run_cycle(self, trigger_reason):
        self.last_run_time = time.strftime("%Y-%m-%d %H:%M:%S")
        self.log(f"开始执行任务 ({trigger_reason})...")
        if not self.pool or not self.pool.accounts:
            self.log("暂无可用的活跃账号，跳过本次巡检")
            return

        refreshed_count = 0
        checkin_count = 0
        travel_count = 0

        for acc in list(self.pool.accounts):
            if self._stop_event.is_set():
                break
            if not acc.enabled:
                continue
            uid8 = acc.uid[:8] if acc.uid else "?"
            # 1. 检查 Token 剩余寿命 (小于 2 小时自动刷新保活)
            exp = acc.expires_at or 0
            if exp and (exp - time.time()) < 7200:
                self.log(f"账号 [{uid8}] Token 即将到期，执行主动保活刷新...")
                if acc.refresh():
                    refreshed_count += 1
                    self.log(f"✓ 账号 [{uid8}] Token 自动保活刷新成功")
                else:
                    self.log(f"! 账号 [{uid8}] Token 保活刷新失败: {acc.last_error}")

            # 2. 如果是国内版账号，检查每日签到与猫猫旅行
            if acc.realm == "cn":
                self._run_growth(acc)
                if not acc.checkin_claimed_today():
                    self.log(f"检测到国内版账号 [{uid8}] 今日尚未签到，执行自动签到...")
                    res = acc.checkin()
                    if res.get("ok"):
                        checkin_count += 1
                        self.log(f"✓ 账号 [{uid8}] 自动签到成功: {res.get('msg')}")
                        try:
                            credits = acc.fetch_credits()
                        except Exception as exc:
                            credits = {"ok": False, "error": str(exc)}
                        if not credits.get("ok"):
                            self.log(f"! 账号 [{uid8}] 签到后积分刷新失败: {credits.get('error')}")
                    else:
                        self.log(f"! 账号 [{uid8}] 自动签到未成功: {res.get('error') or res.get('msg')}")
                    time.sleep(1.0)

                # 检查猫猫旅行
                try:
                    tr = do_cat_travel(acc)
                except Exception as exc:
                    self.log(f"! 账号 [{uid8}] 猫猫日常失败: {exc}")
                    continue
                if tr.get("action") in ("claim", "depart"):
                    travel_count += 1
                    self.log(f"🐱 账号 [{uid8}] 猫猫日常处理: {tr.get('msg')}")
                time.sleep(1.0)

        self.log(f"巡检完成：Token保活 {refreshed_count} 个，每日签到 {checkin_count} 个，猫猫日常 {travel_count} 个")

    def status(self):
        return {
            "enabled": self.enabled,
            "mode": "整点排程 (09:00/21:00 签到旅行 · 22:00 保活 · 01:00 夜猫)",
            "mode_cn": "整点排程 (09:00/21:00 签到旅行 · 22:00 保活 · 01:00 夜猫)",
            "mode_intl": "账号 Token 自动保活与凭证常驻 (每日 22:00 集中巡检)",
            "last_run_time": self.last_run_time or "尚未运行",
            "next_run_time": self.next_run_time or "待调度",
            "logs": self.logs[-20:],
        }
