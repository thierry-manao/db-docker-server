ALTER TABLE `lic_utilisateur` ADD `util_test_account` SMALLINT(1) NOT NULL DEFAULT '0' AFTER `util_idphotoged`;
ALTER TABLE `auth_codes` ADD `util_id` INT NULL AFTER `manager_id`;


ALTER TABLE `auth_codes` 
ADD COLUMN `ac_failed_attempts` INT DEFAULT 0 COMMENT 'Nombre de tentatives échouées' 
AFTER `ac_resend_count`;