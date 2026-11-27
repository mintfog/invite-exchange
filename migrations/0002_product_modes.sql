-- 产品改由管理员创建，并支持两种发码模式：
--   single：一次性码，每个码只能被一个人用（如 ChatterFly，每人可以有好几个码）
--   multi ：多次可用码，一个码可以给很多人用（如 Muse，每人只有一个码，最多 30 人用）
ALTER TABLE products ADD COLUMN mode TEXT NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'multi'));
-- 每个码最多被用几次：single 恒为 1；multi 是分享时的默认值和上限
ALTER TABLE products ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
-- 每人在这个产品下最多放几个码（NULL = 不限）；multi 恒为 1
ALTER TABLE products ADD COLUMN max_codes_per_user INTEGER;
-- 可选：邀请码格式（正则），不符合的不让放
ALTER TABLE products ADD COLUMN code_pattern TEXT;
ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products ADD COLUMN updated_at INTEGER;

-- 码可以被用几次（single 为 1）。用满后 status 变成 claimed。
ALTER TABLE codes ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;

-- 每一次领取一行。一个人同一个产品只能领一次（作废的不算）。
-- code 是领取那一刻的码内容，分享者之后撤回也不影响领取人查看。
CREATE TABLE claims (
  id          TEXT    PRIMARY KEY,
  code_id     TEXT    NOT NULL REFERENCES codes(id),
  product_key TEXT    NOT NULL REFERENCES products(key),
  sharer_id   INTEGER NOT NULL REFERENCES users(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  code        TEXT    NOT NULL,
  claimed_at  INTEGER NOT NULL,
  thanked_at  INTEGER,
  -- 码被管理员确认无效时作废这次领取，领取人可以再领一个
  void_at     INTEGER
);
CREATE UNIQUE INDEX idx_claims_user_product ON claims(user_id, product_key) WHERE void_at IS NULL;
CREATE INDEX idx_claims_code ON claims(code_id);
CREATE INDEX idx_claims_user_time ON claims(user_id, claimed_at);
CREATE INDEX idx_claims_sharer ON claims(sharer_id, product_key);

-- 旧数据：每个已领走的码变成一条领取记录
INSERT INTO claims (id, code_id, product_key, sharer_id, user_id, code, claimed_at, thanked_at)
SELECT id, id, product_key, sharer_id, claimed_by, COALESCE(code, ''), claimed_at, thanked_at
  FROM codes
 WHERE claimed_by IS NOT NULL;

-- 码被用满时自动标记为 claimed（和领取在同一条语句里完成，不会超发）
CREATE TRIGGER trg_claims_fill AFTER INSERT ON claims
BEGIN
  UPDATE codes SET status = 'claimed'
   WHERE id = NEW.code_id AND status = 'available'
     AND (SELECT COUNT(*) FROM claims WHERE code_id = NEW.code_id) >= max_uses;
END;
