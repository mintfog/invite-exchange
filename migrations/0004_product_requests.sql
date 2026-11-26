-- 普通用户申请新产品，管理员通过（建成产品）或拒绝。
--   pending 待审核   approved 已通过（product_key 指向建好的产品）   rejected 已拒绝   canceled 申请人撤回
CREATE TABLE product_requests (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT    NOT NULL,
  product_key  TEXT    NOT NULL,
  mode         TEXT    NOT NULL DEFAULT 'single' CHECK (mode IN ('single', 'multi')),
  max_uses     INTEGER,
  description  TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'canceled')),
  admin_note   TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  INTEGER REFERENCES users(id)
);
-- 同一个产品同时只能有一条待审核的申请
CREATE UNIQUE INDEX idx_product_requests_pending ON product_requests(product_key) WHERE status = 'pending';
CREATE INDEX idx_product_requests_status ON product_requests(status, created_at);
CREATE INDEX idx_product_requests_user   ON product_requests(user_id, created_at);
