-- 预约排队：接力产品暂时没码时，多付一笔押金排队，有码时按顺序自动发。
--   queued      1 = 这笔押金是排队押金（status = 'paid' 时就是还在排队）
--   queue_slot  产品上的发码轮次：有人排队时每 3 个码里 2 个留给现领、1 个发给排队
--   queue_premium_cents  排队比正常押金多付多少（分），默认 200 LDC
ALTER TABLE relay_deposits ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN queue_slot INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO settings (key, value) VALUES ('queue_premium_cents', '20000');
CREATE INDEX idx_relay_deposits_queue ON relay_deposits(product_key, queued, status, paid_at);
