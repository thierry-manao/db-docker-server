-- Script SQL pour ajouter la colonne ac_resend_secondary_count à la table auth_codes
-- Cette colonne permet de suivre si le code a été renvoyé sur l'email secondaire
-- Date: 2026-02-11

-- Vérifier si la colonne existe avant de l'ajouter
ALTER TABLE `auth_codes` 
ADD COLUMN `ac_resend_secondary_count` TINYINT(1) NOT NULL DEFAULT 0 
COMMENT 'Nombre de fois que le code a été renvoyé sur l''email secondaire (max 1)' 
AFTER `ac_resend_count`;

-- Note: Assurez-vous que la table lic_utilisateur possède bien la colonne util_mail2
-- Si ce n'est pas le cas, ajoutez-la avec la commande suivante:
-- ALTER TABLE `lic_utilisateur` 
-- ADD COLUMN IF NOT EXISTS `util_mail2` VARCHAR(255) NULL 
-- COMMENT 'Adresse email secondaire de l\'utilisateur' 
-- AFTER `util_mail`;
