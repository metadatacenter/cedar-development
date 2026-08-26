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
