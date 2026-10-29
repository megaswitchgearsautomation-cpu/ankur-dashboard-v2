"""IoT cloud link settings.   python -m unittest tests.test_iot_link -v   (from the backend folder)"""
import json
import os
import sys
import tempfile
import shutil
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import iot_link  # noqa: E402
from app.config_store import ConfigError, ConfigStore  # noqa: E402


class TestKey(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(iot_link.normalize_key(" https://ABC123.rs485.in/x "), "abc123.rs485.in")
        self.assertEqual(iot_link.normalize_key("tcp://abc.rs485.in:443"), "abc.rs485.in")
        self.assertEqual(iot_link.normalize_key(None), "")

    def test_valid(self):
        self.assertTrue(iot_link.valid_key("megamodbustcp4a58t1.rs485.in"))
        for bad in ("", "abc", "192.168.1.2", "a b.rs485.in", "-x.rs485.in"):
            self.assertFalse(iot_link.valid_key(bad), bad)

    def test_check_key_rejects_garbage_without_network(self):
        self.assertEqual(iot_link.check_key("not a key")["verdict"], "invalid")


class TestSettings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.exe = os.path.join(self.tmp, "comlink.exe")
        open(self.exe, "wb").close()
        self.store = ConfigStore(os.path.join(self.tmp, "config"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_target_follows_link(self):
        s = self.store.settings
        self.assertEqual(iot_link.modbus_target(s), (s["plc"]["host"], s["plc"]["port"]))
        self.store.save_settings({"iot": {"enabled": True, "access_key": "https://abc.rs485.in/",
                                          "local_port": 10777, "comlink_path": self.exe}})
        self.assertEqual(self.store.settings["iot"]["access_key"], "abc.rs485.in")
        self.assertEqual(iot_link.modbus_target(self.store.settings), ("127.0.0.1", 10777))

    def test_enabled_needs_key_and_exe(self):
        with self.assertRaises(ConfigError):
            self.store.save_settings({"iot": {"enabled": True, "access_key": "", "comlink_path": self.exe}})
        with self.assertRaises(ConfigError):
            self.store.save_settings({"iot": {"enabled": True, "access_key": "abc.rs485.in",
                                              "comlink_path": os.path.join(self.tmp, "missing.exe")}})
        with self.assertRaises(ConfigError):
            self.store.save_settings({"iot": {"local_port": 80}})

    def test_secret_never_public(self):
        self.store.save_settings({"iot": {"service_token_id": "id1", "service_token_secret": "s3cret"}})
        pub = self.store.public_settings()
        self.assertNotIn("service_token_secret", pub["iot"])
        self.assertTrue(pub["iot"]["has_token_secret"])
        self.assertNotIn("s3cret", json.dumps(pub))
        self.assertEqual(self.store.settings["iot"]["service_token_secret"], "s3cret")   # still stored
        self.store.save_settings({"iot": {"service_token_id": ""}})                       # clearing the ID drops it
        self.assertEqual(self.store.settings["iot"]["service_token_secret"], "")


if __name__ == "__main__":
    unittest.main()
