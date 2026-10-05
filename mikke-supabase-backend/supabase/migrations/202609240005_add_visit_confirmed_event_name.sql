-- visit_confirmed: 「実際に行った」が初めて成立した瞬間を1回だけ記録するKPIイベント。
-- visit_answered（回答のたびに記録される回答履歴）とは別に、訪問数KPIの正本として使う。
--
-- ALTER TYPE ... ADD VALUE で追加した値は、追加したトランザクションがコミットされるまで
-- 部分インデックスや定数比較で使えない（unsafe use of new value）。そのため値の追加だけを
-- この migration に分離し、実際に使う処理は次の migration（202609240006）で行う。
alter type public.event_name add value if not exists 'visit_confirmed';
