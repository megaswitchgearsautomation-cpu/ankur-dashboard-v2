"""Excel / CSV address import.   python -m unittest tests.test_tag_import -v   (from the backend folder)"""
import os
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from app import tag_import  # noqa: E402
from app.config_store import ConfigStore  # noqa: E402

REAL_CONFIG = os.path.join(os.path.dirname(HERE), "config")


class TestTagImport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        for f in ("settings.json", "tags.json", "equipment.json"):
            if os.path.exists(os.path.join(REAL_CONFIG, f)):
                shutil.copy(os.path.join(REAL_CONFIG, f), self.tmp)
        self.store = ConfigStore(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def by(self, res, key, val):
        return [it for it in res["items"] if it.get(key) == val]

    def test_template_round_trip_is_unchanged(self):
        data = tag_import.template_xlsx(self.store)
        res = tag_import.preview(self.store, "tags.xlsx", data)
        self.assertEqual(res["counts"]["error"], 0, [i for i in res["items"] if i["status"] == "error"][:3])
        self.assertEqual(res["counts"]["update"], 0)
        self.assertEqual(res["counts"]["same"], len(self.store.tags))
        self.assertEqual(res["not_in_file"], [])

    def test_ispsoft_csv_symbol_table(self):
        t01 = next(t for t in self.store.tags if t["id"] == "T_01")
        csv = ("Class,Identifiers,Address,Type,Initial Value,Comment\r\n"
               f"VAR,{t01['plc_tag']},%D11108,REAL,,moved\r\n"           # matched by PLC symbol, new address
               "VAR,Brand_New_Flow,D2000,DINT,,FT-01 Flow total\r\n"      # no match -> new
               "VAR,Bad_One,Q5,BOOL,,bad\r\n"                              # invalid device -> error
               "VAR,Some_Ref,411009,WORD,,custom ref\r\n").encode()
        res = tag_import.preview(self.store, "symbols.csv", csv)
        up = self.by(res, "match", "T_01")[0]
        self.assertEqual((up["status"], up["device"], up["how"]), ("update", "D11108", "PLC symbol"))
        self.assertIn("PT_02", up.get("warning", ""))          # D11108 already belongs to PT-02
        new = self.by(res, "symbol", "Brand_New_Flow")[0]
        self.assertEqual((new["status"], new["data_type"], new["fc"], new["modbus"]), ("new", "INT32", 3, 2000))
        self.assertEqual(self.by(res, "symbol", "Bad_One")[0]["status"], "error")
        ref = self.by(res, "symbol", "Some_Ref")[0]
        self.assertEqual((ref["fc"], ref["modbus"], ref["override"]["address"]), (3, 11008, 411009))

    def test_tag_id_column_and_duplicates(self):
        csv = "Tag ID;Delta device\nT_02;D11018\nT_02;D11020\nT_03;D11030\n".encode()
        res = tag_import.preview(self.store, "x.csv", csv)
        st = [(i["match"], i["status"]) for i in res["items"]]
        self.assertEqual(st[0], ("T_02", "same"))
        self.assertEqual(st[1], ("T_02", "error"))           # second row for the same tag
        self.assertEqual(st[2], ("T_03", "update"))

    def test_no_header_guess(self):
        csv = "AI_Dryer_To_Radiator_01,D11008\nfoo_bar,D500\n".encode()
        res = tag_import.preview(self.store, "x.csv", csv)
        self.assertIsNone(res["header_row"])
        self.assertEqual(res["items"][0]["match"], "T_01")

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            tag_import.preview(self.store, "x.xlsx", b"not a zip")
        with self.assertRaises(ValueError):
            tag_import.preview(self.store, "x.csv", b"hello,world\nfoo,bar\n")


if __name__ == "__main__":
    unittest.main()
