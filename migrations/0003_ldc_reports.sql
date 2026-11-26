-- LDC 分发和无效反馈

-- 站点设置（管理员在「设置」里改）
--   ldc_enabled        '1' 开 / '0' 关，关掉时不记新奖励，也不发待发的
--   share_reward_cents 贡献奖励：每个码第一次被领取、观察期内没人反馈无效，给分享者发一次
--   claim_reward_cents 领取奖励：码每被领取一次，给分享者发一次
--   daily_cap_cents    全站 24 小时内最多发多少（0 = 暂停发放）
--   hold_hours         观察期：领取后等多久才发，期间有人反馈无效就扣下
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('ldc_enabled', '0'),
  ('share_reward_cents', '100'),
  ('claim_reward_cents', '0'),
  ('daily_cap_cents', '10000'),
  ('hold_hours', '24');

-- 单个产品可以覆盖全站金额（NULL = 跟随全站设置）
ALTER TABLE products ADD COLUMN share_reward_cents INTEGER;
ALTER TABLE products ADD COLUMN claim_reward_cents INTEGER;

-- 管理员确认无效的时间（码同时被撤下）
ALTER TABLE codes ADD COLUMN invalid_at INTEGER;

-- LDC 发放记录。id 就是 LDC 的 out_trade_no，同一笔重试不会重复到账。
--   kind  share：贡献奖励，每个码一笔（id = share-<码 id>）
--         claim：领取奖励，每次领取一笔（id = claim-<领取 id>）
--   status pending 等观察期结束   held 有人反馈无效，等管理员处理   sending 正在发
--          sent 已到账   failed 发送失败（可重试）   canceled 不发了
CREATE TABLE payouts (
  id           TEXT    PRIMARY KEY,
  kind         TEXT    NOT NULL CHECK (kind IN ('share', 'claim')),
  code_id      TEXT    NOT NULL REFERENCES codes(id),
  claim_id     TEXT    NOT NULL REFERENCES claims(id),
  product_key  TEXT    NOT NULL REFERENCES products(key),
  sharer_id    INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'held', 'sending', 'sent', 'failed', 'canceled')),
  due_at       INTEGER NOT NULL,
  trade_no     TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  sent_at      INTEGER
);
CREATE INDEX idx_payouts_due    ON payouts(status, due_at);
CREATE INDEX idx_payouts_code   ON payouts(code_id);
CREATE INDEX idx_payouts_sharer ON payouts(sharer_id, created_at);
CREATE INDEX idx_payouts_sent   ON payouts(status, sent_at);

-- 领取人反馈「这个码用不了」。每次领取只能反馈一次。
--   open 待处理   confirmed 管理员确认无效   dismissed 管理员认为码没问题
CREATE TABLE reports (
  id          TEXT    PRIMARY KEY,
  claim_id    TEXT    NOT NULL UNIQUE REFERENCES claims(id),
  code_id     TEXT    NOT NULL REFERENCES codes(id),
  product_key TEXT    NOT NULL REFERENCES products(key),
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  sharer_id   INTEGER NOT NULL REFERENCES users(id),
  reason      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'dismissed')),
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE INDEX idx_reports_status ON reports(status, created_at);
CREATE INDEX idx_reports_code   ON reports(code_id);
