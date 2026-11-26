-- 用户：只来自 LinuxDO OAuth
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  linuxdo_id    INTEGER NOT NULL UNIQUE,
  username      TEXT    NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  trust_level   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- 登录会话：只存 token 的 SHA-256
CREATE TABLE sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 产品：第一次有人分享时创建，key 是规范化后的名字
CREATE TABLE products (
  key        TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

-- 邀请码
--   available：在池子里，谁都看不到码本身
--   claimed  ：已被领取，只有领取人和分享者能看到
--   withdrawn：分享者撤回，码内容清空
CREATE TABLE codes (
  id          TEXT    PRIMARY KEY,
  sharer_id   INTEGER NOT NULL REFERENCES users(id),
  product_key TEXT    NOT NULL REFERENCES products(key),
  code        TEXT,
  note        TEXT,
  status      TEXT    NOT NULL DEFAULT 'available'
              CHECK (status IN ('available', 'claimed', 'withdrawn')),
  created_at  INTEGER NOT NULL,
  claimed_by  INTEGER REFERENCES users(id),
  claimed_at  INTEGER,
  thanked_at  INTEGER
);
CREATE INDEX idx_codes_pool    ON codes(product_key, status);
CREATE INDEX idx_codes_sharer  ON codes(sharer_id, created_at);
CREATE INDEX idx_codes_claimer ON codes(claimed_by, claimed_at);
-- 同一个产品下，同一个码不能重复进池子
CREATE UNIQUE INDEX idx_codes_unique_live
  ON codes(product_key, code) WHERE status <> 'withdrawn';
