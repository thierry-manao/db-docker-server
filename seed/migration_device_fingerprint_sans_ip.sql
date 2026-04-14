-- Migration SQL - Ajout de champs pour identification par navigateur (sans IP)
-- Date: 2026-02-03
-- Description: Ajouter des champs pour identifier un appareil par ordinateur+navigateur

-- Ajouter les nouveaux champs pour l'identification du navigateur
ALTER TABLE `device_info_cli` 
ADD COLUMN `screen_resolution` VARCHAR(50) NULL AFTER `accept_language`,
ADD COLUMN `timezone_offset` VARCHAR(10) NULL AFTER `screen_resolution`,
ADD COLUMN `browser_fingerprint` VARCHAR(100) NULL AFTER `timezone_offset`,
ADD COLUMN `device_name` VARCHAR(255) NULL COMMENT 'Nom descriptif: ex "Ordi fixe Guillaume - Chrome 120"' AFTER `browser_fingerprint`;

-- Ajouter un index sur le fingerprint pour améliorer les performances
ALTER TABLE `device_info_cli` 
ADD INDEX `idx_fingerprint` (`device_fingerprint`),
ADD INDEX `idx_browser_fp` (`browser_fingerprint`);

-- Mettre à jour les commentaires de colonnes pour clarifier
ALTER TABLE `device_info_cli` 
MODIFY COLUMN `device_fingerprint` VARCHAR(255) NOT NULL COMMENT 'Hash SHA-256 basé sur: User-Agent + Navigateur + OS (SANS IP pour éviter problème IP dynamique)',
MODIFY COLUMN `ip_address` VARCHAR(45) NULL COMMENT 'IP actuelle (stockée pour info mais NON utilisée dans fingerprint)',
MODIFY COLUMN `last_ip` VARCHAR(45) NULL COMMENT 'Dernière IP connue (stockée pour info mais NON utilisée dans fingerprint)';

-- Afficher la structure mise à jour
SHOW CREATE TABLE `device_info_cli`;


ALTER TABLE `api_appels_historique` CHANGE `enterprise_num` `entreprise_num` VARCHAR(45) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL;