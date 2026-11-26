import json
from pathlib import Path
import unittest


DEVELOPMENT = Path(__file__).resolve().parents[2]
REALM_SEED = (
    DEVELOPMENT
    / "os-mirror"
    / "development-macos"
    / "CEDAR_HOME"
    / "keycloak"
    / "keycloak-realm.CEDAR.development.2023-07-05.json"
)


class KeycloakRealmSeedTest(unittest.TestCase):
    def test_browser_clients_keep_legacy_adapter_token_claims(self):
        realm = json.loads(REALM_SEED.read_text(encoding="utf-8"))
        clients = {client["clientId"]: client for client in realm["clients"]}
        for name in ("cedar-angular-app", "cedar-frontend-bridging", "cedar-frontend-monitoring"):
            with self.subTest(client=name):
                self.assertEqual("true", clients[name]["attributes"]["exclude.issuer.from.auth.response"])
                mappers = {mapper["protocolMapper"]: mapper for mapper in clients[name]["protocolMappers"]}
                self.assertIn("oidc-nonce-backwards-compatible-mapper", mappers)
                session = mappers["oidc-session-state-mapper"]["config"]
                self.assertEqual("true", session["access.token.claim"])
                self.assertEqual("true", session["id.token.claim"])

    def test_mirrored_realm_seed_contains_no_generated_key_material(self):
        realm = json.loads(REALM_SEED.read_text(encoding="utf-8"))
        providers = realm.get("components", {}).get(
            "org.keycloak.keys.KeyProvider", []
        )
        self.assertEqual(
            [],
            providers,
            "Realm seeds must let each Keycloak installation generate unique providers",
        )


if __name__ == "__main__":
    unittest.main()
