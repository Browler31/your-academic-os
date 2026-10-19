#!/usr/bin/env python3
"""
ZHAW Legal Study OS -> Google NotebookLM Exporter & PDF Combiner
Uses jacob-bd/gemini-notebook-mcp-cli (`nlm`) + `pypdf` to:
1. Combine all Moodle PDFs per course (Vorlesungen, Übungsfälle, Lösungsskizzen) in chronological SW 1..14 order.
2. Save the combined Master-PDFs into ~/Downloads/ZHAW-NotebookLM-Exports/<Course Name>/.
3. Automatically create a NotebookLM notebook with the exact same course name and upload the combined PDFs via `nlm`.
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request
from pypdf import PdfReader, PdfWriter

SUPABASE_URL = "https://rtbtbzjnjqbmtrmyigxc.supabase.co"
SUPABASE_KEY = "sb_publishable_8mP_0CQw-xG9gP19FSHNiw_UBH_Pxbb"


def norm(s: str) -> str:
    return unicodedata.normalize("NFC", s or "")


def detect_week(fname: str) -> int:
    s = norm(fname)
    m = re.search(r"(?:^|[\s_.-])(?:SW|UW|VL|Lektion|Semesterwoche|Woche|L|Ü|Uebung|Übung)\s*0*(\d{1,2})[a-z]?(?=$|[\s_.-])", s, re.I)
    if m:
        w = int(m.group(1))
        if 1 <= w <= 16:
            return w
    return 99


def classify_role(fname: str) -> str:
    s = norm(fname).lower()
    if re.search(r"(lösungsskizze|musterlösung|falllösung|lösungsvorschläge|lösungsvorschlag|loesung|lösungen)", s):
        return "solution"
    if re.search(r"(übungsfälle|übungen|uebungen|fallskript|arbeitsblatt|ü\d+)", s):
        return "exercise"
    if re.search(r"(modulbeschreibung|modulübersicht|semesterprogramm|leistungsnachweis|usln|merkblatt|bearbeitungshinweise|leseliste|checkliste|einführungsveranstaltung|sachverhalt legal memorandum)", s):
        return "compass"
    if detect_week(fname) < 99 or re.search(r"(vorlesung|präsentation|skript|factsheet|repetitionsfragen)", s):
        return "lecture"
    return "reference"


def api_get(path: str):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/{path}",
        headers={"apikey": SUPABASE_KEY, "User-Agent": "ZHAW-Legal-OS/1.0"},
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read().decode("utf-8"))


def merge_pdf_group(files, out_path: str) -> int:
    writer = PdfWriter()
    merged_files = 0
    for f in files:
        url = f.get("file_url")
        fname = norm(f.get("file_name", ""))
        if not url or not fname.lower().endswith(".pdf"):
            continue
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            raw = urllib.request.urlopen(req, timeout=30).read()
            reader = PdfReader(io.BytesIO(raw))
            if len(reader.pages) == 0:
                continue
            for page in reader.pages:
                writer.add_page(page)
            merged_files += 1
        except Exception as e:
            print(f"    [!] Überspringe {fname}: {e}")
    if merged_files > 0:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f_out:
            writer.write(f_out)
    return merged_files


def ensure_nlm_notebook(title: str) -> str:
    res = subprocess.run(["nlm", "notebook", "list", "--json"], capture_output=True, text=True)
    if res.returncode == 0 and res.stdout.strip():
        try:
            for nb in json.loads(res.stdout):
                if nb.get("title") == title:
                    return nb.get("id")
        except Exception:
            pass
    cr = subprocess.run(["nlm", "notebook", "create", title, "--json"], capture_output=True, text=True, check=True)
    try:
        return json.loads(cr.stdout).get("id") or title
    except Exception:
        return title


def main():
    parser = argparse.ArgumentParser(description="Combine ZHAW Course PDFs and export to Google NotebookLM via nlm CLI.")
    parser.add_argument("--semester", default="2026-HS", help="Semester filter (default: 2026-HS)")
    parser.add_argument("--course", default="", help="Optional substring filter for course name")
    parser.add_argument("--out-dir", default=os.path.expanduser("~/Downloads/ZHAW-NotebookLM-Exports"), help="Output folder for merged PDFs")
    parser.add_argument("--merge-only", action="store_true", help="Only combine and save PDFs locally without running nlm upload")
    args = parser.parse_args()

    os.environ["PATH"] = os.path.expanduser("~/.local/bin") + ":" + os.environ.get("PATH", "")

    courses = api_get("courses?select=id,name,short_name&order=name.asc")
    target_courses = [
        c for c in courses
        if (not args.semester or args.semester.lower() in (c.get("name", "") + " " + c.get("short_name", "")).lower())
        and (not args.course or args.course.lower() in c.get("name", "").lower())
    ]

    print(f"Gefundene Kurse für '{args.semester}': {len(target_courses)}")
    if not args.merge_only:
        chk = subprocess.run(["nlm", "login", "--check"], capture_output=True, text=True)
        if chk.returncode != 0:
            print("Starte einmaliges Google-Login für NotebookLM (`nlm login`)...")
            subprocess.run(["nlm", "login"], check=True)

    for c in target_courses:
        cid = c["id"]
        cname = norm(c["name"])
        safe_cname = re.sub(r"[/\\?%*:|\"<>]", "-", cname)
        course_dir = os.path.join(args.out_dir, safe_cname)

        raw_files = api_get(f"files?select=id,file_name,file_url&course_id=eq.{cid}")
        pdf_files = [
            f for f in raw_files
            if f.get("file_url") and norm(f.get("file_name", "")).lower().endswith(".pdf")
        ]
        for f in pdf_files:
            f["_week"] = detect_week(f["file_name"])
            f["_role"] = classify_role(f["file_name"])

        pdf_files.sort(key=lambda x: (x["_week"], x["file_name"]))

        lectures = [f for f in pdf_files if f["_role"] in ("compass", "lecture")]
        exercises = [f for f in pdf_files if f["_role"] == "exercise"]
        solutions = [f for f in pdf_files if f["_role"] == "solution"]
        core_all = [f for f in pdf_files if f["_role"] in ("compass", "lecture", "exercise", "solution")]

        print(f"\n=== {cname} ({len(core_all)} Kern-PDFs) ===")
        combined_paths = []

        p_all = os.path.join(course_dir, f"{safe_cname} - 0_Komplett_Vorlesungen_Uebungen_Loesungen.pdf")
        cnt_all = merge_pdf_group(core_all, p_all)
        if cnt_all > 0:
            print(f"  [✓] Komplett-PDF erstellt ({cnt_all} PDFs kombiniert): {p_all}")

        groups = [
            ("1_Vorlesungen_und_Theorie", lectures),
            ("2_Uebungsfaelle_und_Sachverhalte", exercises),
            ("3_Offizielle_ZHAW_Loesungsskizzen", solutions),
        ]
        for label, gfiles in groups:
            if not gfiles:
                continue
            out_p = os.path.join(course_dir, f"{safe_cname} - {label}.pdf")
            cnt = merge_pdf_group(gfiles, out_p)
            if cnt > 0:
                print(f"  [✓] {label}: {cnt} PDFs kombiniert -> {os.path.basename(out_p)}")
                combined_paths.append(out_p)

        if not args.merge_only and (combined_paths or cnt_all > 0):
            nb_id = ensure_nlm_notebook(cname)
            print(f"  [NotebookLM] Kurs '{cname}' bereit (ID: {nb_id}) – lade Sammel-PDFs hoch...")
            upload_targets = combined_paths if combined_paths else [p_all]
            for up in upload_targets:
                subprocess.run(["nlm", "source", "add", str(nb_id), "--file", up, "--wait"], check=False)
            print(f"  [NotebookLM] ✅ '{cname}' vollständig synchronisiert!")

    print(f"\n🎉 Alle Sammel-PDFs liegen bereit unter: {args.out_dir}")


if __name__ == "__main__":
    main()
