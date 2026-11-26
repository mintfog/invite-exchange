-- 接力押金：领需要接力的产品前先付押金；领到后放回自己的同产品邀请码，
-- 等别人领走它、过了观察期没人反馈无效，押金原路退回。
--   relay_enabled        '1' 开 / '0' 关（全站开关）
--   relay_deposit_cents  押金多少 LDC（单位：分）
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('relay_enabled', '0'),
  ('relay_deposit_cents', '500');

-- 哪些产品要接力（管理员在产品设置里勾）
ALTER TABLE products ADD COLUMN relay_required INTEGER NOT NULL DEFAULT 0;

-- 押金。id 就是发给 LINUX DO Credit 的 out_trade_no
--   pending     已下单，还没付
--   paid        已付，还没用来领码（可以申请退回）
--   used        已用来领码，等用户放回自己的码、并被别人领走
--   refund_due  放回的码被别人领了，观察期过后退款
--   refunding   正在调 LDC 退款
--   refunded    已退回
--   refund_failed 退款失败（看 error，管理员可以重试）
--   forfeited   管理员没收
CREATE TABLE relay_deposits (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  product_key   TEXT    NOT NULL REFERENCES products(key),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  status        TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN
                  ('pending', 'paid', 'used', 'refund_due', 'refunding', 'refunded', 'refund_failed', 'forfeited')),
  trade_no      TEXT,
  claim_id      TEXT    REFERENCES claims(id),
  relay_code_id TEXT    REFERENCES codes(id),
  refund_due_at INTEGER,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  paid_at       INTEGER,
  refunded_at   INTEGER,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_relay_deposits_user   ON relay_deposits(user_id, product_key, status);
CREATE INDEX idx_relay_deposits_status ON relay_deposits(status, refund_due_at);
CREATE INDEX idx_relay_deposits_code   ON relay_deposits(relay_code_id);
CREATE INDEX idx_relay_deposits_claim  ON relay_deposits(claim_id);
