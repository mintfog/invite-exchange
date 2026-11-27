-- 每个产品自己的押金、最低领取信任等级、分档押金
ALTER TABLE products ADD COLUMN deposit_cents INTEGER;
ALTER TABLE products ADD COLUMN min_trust_level INTEGER;
ALTER TABLE products ADD COLUMN deposit_tiers TEXT;
