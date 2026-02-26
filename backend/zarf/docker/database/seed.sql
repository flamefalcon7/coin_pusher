-- Seed test accounts for development.
INSERT INTO accounts (account_id, display_name, balance_usdc, balance_play, balance_cash) VALUES
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Test Player 1', 100.000000, 1000.0000, 50.0000),
    ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'Test Player 2', 50.000000, 500.0000, 25.0000),
    ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'Test Player 3', 0.000000, 0.0000, 0.0000)
ON CONFLICT (account_id) DO NOTHING;

-- Seed auth providers for test accounts (wallet-based login).
INSERT INTO auth_providers (account_id, provider_type, provider_uid) VALUES
    ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'wallet', '0xtest1'),
    ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'wallet', '0xtest2'),
    ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'wallet', '0xtest3')
ON CONFLICT (provider_type, provider_uid) DO NOTHING;
