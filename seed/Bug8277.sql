CREATE INDEX idx_util_login ON lic_utilisateur(util_login);
CREATE INDEX idx_auth_search ON lic_utilogauth(auth_ip, auth_datedemande, util_id);
