-- 1. 重复码校验：分享时把码规范化（去掉空白、转小写）后算 SHA-256 存下来。
--    码被领走、撤回或确认无效后也留着，用来拦住「一个码在两个号之间来回倒」。
ALTER TABLE codes ADD COLUMN code_hash TEXT;
CREATE INDEX idx_codes_hash ON codes(product_key, code_hash);

-- 2. 领取人自己退还用不了的码：记成一条反馈，self_return = 1
ALTER TABLE reports ADD COLUMN self_return INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_reports_reporter ON reports(reporter_id, self_return, created_at);

-- 3. 接力链图：只显示头像不显示名字，头像走本站的匿名地址 /api/avatars/{avatar_key}
ALTER TABLE users ADD COLUMN avatar_key TEXT;
CREATE UNIQUE INDEX idx_users_avatar_key ON users(avatar_key);
