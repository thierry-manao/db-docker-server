CREATE TABLE IF NOT EXISTS `device_info_cli` (
  `device_id` INT(11) NOT NULL AUTO_INCREMENT,
  `util_id` INT(11) NOT NULL COMMENT 'ID utilisateur',
  `device_fingerprint` VARCHAR(64) NOT NULL COMMENT 'Empreinte unique appareil',
  
  -- Informations réseau
  `ip_address` VARCHAR(45) NOT NULL COMMENT 'IP enregistrement',
  `last_ip` VARCHAR(45) NULL COMMENT 'Dernière IP utilisée',
  
  -- Informations navigateur
  `browser` VARCHAR(50) NULL,
  `browser_version` VARCHAR(20) NULL,
  `user_agent` TEXT NULL,
  
  -- Informations appareil
  `platform` VARCHAR(100) NULL,
  `device_type` ENUM('Desktop', 'Mobile', 'Tablet') DEFAULT 'Desktop',
  `device_brand` VARCHAR(50) NULL,
  `device_model` VARCHAR(100) NULL,
  `os_name` VARCHAR(50) NULL,
  `os_version` VARCHAR(20) NULL,
  
  -- Flags
  `is_mobile` TINYINT(1) DEFAULT 0,
  `is_tablet` TINYINT(1) DEFAULT 0,
  `is_trusted` TINYINT(1) DEFAULT 0 COMMENT '1 = Appareil de confiance (pas de 2FA)',
  
  -- Dates de confiance
  `trusted_at` DATETIME NULL COMMENT 'Date validation 2FA',
  
  -- Autres
  `accept_language` VARCHAR(255) NULL,
  
  -- Statistiques
  `usage_count` INT(11) DEFAULT 1 COMMENT 'Nombre de connexions',
  `first_seen` DATETIME NOT NULL COMMENT 'Première connexion',
  `last_seen` DATETIME NOT NULL COMMENT 'Dernière connexion',
  
  -- Soft delete
  `deleted_at` DATETIME NULL,
  `token` MEDIUMTEXT NOT NULL,
  
  PRIMARY KEY (`device_id`),
  UNIQUE KEY `unique_device_user` (`device_fingerprint`, `util_id`),
  KEY `idx_util_id` (`util_id`),
  KEY `idx_fingerprint` (`device_fingerprint`),
  KEY `idx_last_seen` (`last_seen`),
  KEY `idx_util_trusted` (`util_id`, `is_trusted`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


ALTER TABLE `lic_utilogauth` ADD `device_id` INT NULL AFTER `auth_lang`;
