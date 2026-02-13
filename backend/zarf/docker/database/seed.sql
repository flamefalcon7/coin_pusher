-- Seed test users for development.
INSERT INTO users (user_id, name, sui_address, balance_coin, balance_usdc) VALUES
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Test Player 1', '0xtest1', 1000.0000, 100.000000),
    ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'Test Player 2', '0xtest2', 500.0000, 50.000000),
    ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'Test Player 3', '0xtest3', 0.0000, 0.000000)
ON CONFLICT (sui_address) DO NOTHING;
