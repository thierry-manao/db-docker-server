CREATE TABLE IF NOT EXISTS accounting_accounts (
	id INT AUTO_INCREMENT PRIMARY KEY,
	account_number VARCHAR(20) NOT NULL UNIQUE,
	label VARCHAR(120) NOT NULL,
	account_type VARCHAR(40) NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounting_entries (
	id INT AUTO_INCREMENT PRIMARY KEY,
	entry_ref VARCHAR(40) NOT NULL UNIQUE,
	account_id INT NOT NULL,
	entry_date DATE NOT NULL,
	description VARCHAR(255) NOT NULL,
	debit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
	credit DECIMAL(10,2) NOT NULL DEFAULT 0.00,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT fk_accounting_entries_account
		FOREIGN KEY (account_id) REFERENCES accounting_accounts(id)
		ON DELETE CASCADE
);

INSERT INTO accounting_accounts (account_number, label, account_type)
VALUES
	('401000', 'Suppliers', 'liability'),
	('411000', 'Customers', 'asset'),
	('706000', 'Service Revenue', 'income'),
	('512000', 'Bank', 'asset')
ON DUPLICATE KEY UPDATE
	label = VALUES(label),
	account_type = VALUES(account_type);

INSERT INTO accounting_entries (entry_ref, account_id, entry_date, description, debit, credit)
SELECT entry_ref, account_id, entry_date, description, debit, credit
FROM (
	SELECT 'AC-2026-0001' AS entry_ref, a.id AS account_id, DATE('2026-04-01') AS entry_date, 'Client invoice settlement' AS description, 2500.00 AS debit, 0.00 AS credit
	FROM accounting_accounts a
	WHERE a.account_number = '512000'

	UNION ALL

	SELECT 'AC-2026-0002' AS entry_ref, a.id AS account_id, DATE('2026-04-01') AS entry_date, 'Client invoice settlement' AS description, 0.00 AS debit, 2500.00 AS credit
	FROM accounting_accounts a
	WHERE a.account_number = '411000'

	UNION ALL

	SELECT 'AC-2026-0003' AS entry_ref, a.id AS account_id, DATE('2026-04-02') AS entry_date, 'Monthly service revenue' AS description, 0.00 AS debit, 4200.00 AS credit
	FROM accounting_accounts a
	WHERE a.account_number = '706000'
) AS seed_rows
WHERE NOT EXISTS (
	SELECT 1
	FROM accounting_entries e
	WHERE e.entry_ref = seed_rows.entry_ref
);
