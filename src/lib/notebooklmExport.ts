import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ClassifiedFile, StructuredCourse } from "./courseStructure";

export interface MergeFilterOptions {
  includeLectures: boolean;
  includeFactsheets: boolean;
  includeExercises: boolean;
  includeSolutions: boolean;
  includeCompass: boolean;
  includeReference: boolean;
}

export interface MergeProgress {
  current: number;
  total: number;
  fileName: string;
  phase: "fetching" | "merging" | "saving" | "done";
}

function toWinAnsiSafe(text: string): string {
  return (text || "")
    .normalize("NFC")
    .replace(/[„“”«»]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[•·]/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
}

export function collectFilesForExport(
  structured: StructuredCourse,
  opts: MergeFilterOptions
): ClassifiedFile[] {
  const list: ClassifiedFile[] = [];

  if (opts.includeCompass) {
    list.push(...structured.compassDocs, ...structured.oldExams);
  }

  for (const ch of structured.chapters) {
    if (opts.includeLectures) list.push(...ch.lectures);
    if (opts.includeFactsheets) list.push(...ch.factsheets);
    if (opts.includeExercises) list.push(...ch.exercises);
    if (opts.includeSolutions) list.push(...ch.solutions);
  }

  if (opts.includeReference) {
    list.push(...structured.referenceDocs);
  }

  // Only include PDFs with a valid URL
  return list.filter(
    (f) => f.file_url && f.file_name.toLowerCase().endsWith(".pdf")
  );
}

export async function mergeCoursePdfsToBytes(
  courseTitle: string,
  semesterLabel: string,
  files: ClassifiedFile[],
  deepNotesSummary?: {
    definitions?: { term: string; definition: string; norm_anchor: string }[];
    pruefungsschemaTitle?: string;
    pruefungsschemaSteps?: { step: string; detail: string }[];
  },
  onProgress?: (p: MergeProgress) => void
): Promise<{ bytes: Uint8Array; mergedCount: number; skippedFiles: string[] }> {
  const mergedPdf = await PDFDocument.create();
  const fontBold = await mergedPdf.embedFont(StandardFonts.HelveticaBold);
  const fontRegular = await mergedPdf.embedFont(StandardFonts.Helvetica);

  // 1. Create Cover Page + Table of Contents + ZHAW Gutachtenstil & Definitionen Primer
  const coverPage = mergedPdf.addPage([595.28, 841.89]); // A4
  const { height } = coverPage.getSize();
  let y = height - 60;

  coverPage.drawText(toWinAnsiSafe("ZHAW Legal Study OS - NotebookLM Master-PDF"), {
    x: 50,
    y,
    size: 11,
    font: fontBold,
    color: rgb(0.05, 0.45, 0.75),
  });
  y -= 28;

  coverPage.drawText(toWinAnsiSafe(courseTitle).slice(0, 65), {
    x: 50,
    y,
    size: 20,
    font: fontBold,
    color: rgb(0.08, 0.1, 0.15),
  });
  y -= 20;

  coverPage.drawText(
    toWinAnsiSafe(
      `${semesterLabel} | Kombiniertes Sammel-Dokument (${files.length} PDF-Quellen)`
    ),
    {
      x: 50,
      y,
      size: 11,
      font: fontRegular,
      color: rgb(0.35, 0.4, 0.45),
    }
  );
  y -= 28;

  // Add Gutachtenstil & Syllogismus Rule Box for NotebookLM AI Context
  const ruleLines = [
    "WICHTIGER HINWEIS FUER NOTEBOOKLM (ZHAW RECHTSWISSENSCHAFT):",
    "1. Gutachtenstil & 4-Schritt-Syllogismus: Alle Fallloesungen in diesem Modul folgen strikt dem Aufbau:",
    "   (a) Obersatz (Hypothese im Konjunktiv: 'Fraglich / Zu pruefen ist, ob...')",
    "   (b) Voraussetzungen & Definition (Rechtssatz: Gesetzesnorm + ungeschriebene BGE-/Lehrbuch-Definition)",
    "   (c) Subsumtion (Untersatz: Konkreter Sachverhalt unter jedes Merkmal der Definition legen: 'Vorliegend...')",
    "   (d) Konklusion (Schlusssatz: 'Folglich / Somit ist das Tatbestandsmerkmal erfuellt.')",
    "2. Ungeschriebene Definitionen (z.B. Schaden nach Differenztheorie, Adaequate Kausalitaet, Widerrechtlichkeit,",
    "   Skrupellosigkeit, Verhaeltnismaessigkeit) stehen NICHT im Gesetzestext und muessen wuetlich sitzen.",
  ];

  for (const rl of ruleLines) {
    coverPage.drawText(toWinAnsiSafe(rl), {
      x: 50,
      y,
      size: 9.5,
      font: rl.startsWith("WICHTIGER") ? fontBold : fontRegular,
      color: rgb(0.15, 0.2, 0.25),
    });
    y -= 14;
  }

  y -= 14;
  coverPage.drawText(toWinAnsiSafe("Inhaltsverzeichnis der kombinierten Kurs-PDFs:"), {
    x: 50,
    y,
    size: 12,
    font: fontBold,
    color: rgb(0.08, 0.1, 0.15),
  });
  y -= 18;

  for (let i = 0; i < Math.min(files.length, 32); i++) {
    const f = files[i];
    const prefix = f.weekNumber ? `[SW ${f.weekNumber} - ${f.roleLabel}]` : `[${f.roleLabel}]`;
    const line = `${i + 1}. ${prefix} ${f.clean_title}`.slice(0, 88);
    coverPage.drawText(toWinAnsiSafe(line), {
      x: 55,
      y,
      size: 9,
      font: fontRegular,
      color: rgb(0.2, 0.25, 0.3),
    });
    y -= 13;
    if (y < 60) break;
  }

  // If we have Auswendig-Definitionen, add a dedicated Definitions & Prüfungsschema page for NotebookLM
  if (deepNotesSummary?.definitions && deepNotesSummary.definitions.length > 0) {
    const defPage = mergedPdf.addPage([595.28, 841.89]);
    let dy = height - 55;
    defPage.drawText(
      toWinAnsiSafe(`${courseTitle} - Auswendig-Definitionen & Pruefungsschema`),
      {
        x: 50,
        y: dy,
        size: 14,
        font: fontBold,
        color: rgb(0.05, 0.45, 0.75),
      }
    );
    dy -= 24;

    for (const d of deepNotesSummary.definitions) {
      if (dy < 110) break;
      defPage.drawText(toWinAnsiSafe(`${d.term} (${d.norm_anchor})`).slice(0, 85), {
        x: 50,
        y: dy,
        size: 10.5,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.15),
      });
      dy -= 14;

      const words = toWinAnsiSafe(d.definition).split(/\s+/);
      let currentLine = "";
      for (const w of words) {
        if ((currentLine + " " + w).length > 92) {
          defPage.drawText(currentLine.trim(), {
            x: 55,
            y: dy,
            size: 9.5,
            font: fontRegular,
            color: rgb(0.2, 0.2, 0.25),
          });
          dy -= 13;
          currentLine = w;
        } else {
          currentLine += " " + w;
        }
      }
      if (currentLine.trim()) {
        defPage.drawText(currentLine.trim(), {
          x: 55,
          y: dy,
          size: 9.5,
          font: fontRegular,
          color: rgb(0.2, 0.2, 0.25),
        });
        dy -= 18;
      }
    }
  }

  // 2. Fetch & Merge each PDF in chronological order with a clear Section Divider Page
  let mergedCount = 0;
  const skippedFiles: string[] = [];

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    onProgress?.({
      current: idx + 1,
      total: files.length,
      fileName: f.file_name,
      phase: "fetching",
    });

    try {
      const resp = await fetch(f.file_url!);
      if (!resp.ok) {
        skippedFiles.push(f.file_name);
        continue;
      }
      const arrayBuf = await resp.arrayBuffer();
      const srcDoc = await PDFDocument.load(arrayBuf, { ignoreEncryption: true });
      const pageIndices = srcDoc.getPageIndices();
      if (pageIndices.length === 0) continue;

      // Add a compact divider page before each document so NotebookLM knows the exact source & week
      const divPage = mergedPdf.addPage([595.28, 841.89]);
      divPage.drawText(
        toWinAnsiSafe(
          f.weekNumber ? `SEMESTERWOCHE ${f.weekNumber} (${f.roleLabel.toUpperCase()})` : f.roleLabel.toUpperCase()
        ),
        {
          x: 50,
          y: 460,
          size: 13,
          font: fontBold,
          color: rgb(0.05, 0.45, 0.75),
        }
      );
      divPage.drawText(toWinAnsiSafe(f.clean_title).slice(0, 70), {
        x: 50,
        y: 430,
        size: 18,
        font: fontBold,
        color: rgb(0.1, 0.12, 0.18),
      });
      divPage.drawText(toWinAnsiSafe(`Originaldatei: ${f.file_name} (${pageIndices.length} Seiten)`).slice(0, 85), {
        x: 50,
        y: 405,
        size: 10,
        font: fontRegular,
        color: rgb(0.4, 0.45, 0.5),
      });

      onProgress?.({
        current: idx + 1,
        total: files.length,
        fileName: f.file_name,
        phase: "merging",
      });

      const copiedPages = await mergedPdf.copyPages(srcDoc, pageIndices);
      for (const cp of copiedPages) {
        mergedPdf.addPage(cp);
      }
      mergedCount++;
    } catch (e) {
      console.warn("Skipping non-mergeable PDF:", f.file_name, e);
      skippedFiles.push(f.file_name);
    }
  }

  onProgress?.({
    current: files.length,
    total: files.length,
    fileName: "Speichere Sammel-PDF...",
    phase: "saving",
  });

  const bytes = await mergedPdf.save();
  onProgress?.({
    current: files.length,
    total: files.length,
    fileName: "Fertig!",
    phase: "done",
  });

  return { bytes, mergedCount, skippedFiles };
}

export function triggerPdfDownload(bytes: Uint8Array, filename: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Generates an automated CLI command for jacob-bd/gemini-notebook-mcp-cli (`nlm`)
 * that creates a NotebookLM notebook with the exact course name, merges the selected
 * course PDFs locally, and uploads them via `nlm source add <notebook> --file ... --wait`.
 */
export function buildNlmCliCommand(
  courseFullTitle: string,
  files: ClassifiedFile[],
  deepNotesDefinitions: { term: string; definition: string; norm_anchor: string }[] = []
): string {
  const safeNotebookTitle = courseFullTitle.replace(/"/g, '\\"');
  const fileManifest = files.map((f) => ({
    name: f.file_name,
    role: f.role,
    week: f.weekNumber,
    url: f.file_url,
  }));

  const manifestBase64 = btoa(
    unescape(encodeURIComponent(JSON.stringify({ title: courseFullTitle, files: fileManifest, defs: deepNotesDefinitions })))
  );

  return `export PATH="$HOME/.local/bin:$PATH"
uv run --with pypdf python3 -c '
import base64, json, os, subprocess, tempfile, urllib.request
from pypdf import PdfWriter, PdfReader
import io

data = json.loads(base64.b64decode("${manifestBase64}").decode("utf-8"))
title = data["title"]
files = data["files"]

print(f"=== 1. Prüfe NotebookLM Login (nlm) ===")
chk = subprocess.run(["nlm", "login", "--check"], capture_output=True, text=True)
if chk.returncode != 0:
    print("Bitte einmalig im Browser bei Google NotebookLM anmelden...")
    subprocess.run(["nlm", "login"], check=True)

print(f"=== 2. Erstelle / Suche NotebookLM Kurs: {title} ===")
nb_list = subprocess.run(["nlm", "notebook", "list", "--json"], capture_output=True, text=True)
nb_id = None
if nb_list.returncode == 0 and nb_list.stdout.strip():
    try:
        for nb in json.loads(nb_list.stdout):
            if nb.get("title") == title:
                nb_id = nb.get("id")
                break
    except Exception:
        pass

if not nb_id:
    cr = subprocess.run(["nlm", "notebook", "create", title, "--json"], capture_output=True, text=True, check=True)
    try:
        nb_id = json.loads(cr.stdout).get("id")
    except Exception:
        nb_id = title

print(f"-> Notebook aktiv: {title} (ID: {nb_id})")

workdir = tempfile.mkdtemp(prefix="zhaw_nlm_")
groups = {
    "1_Vorlesungen_und_Theorie": [f for f in files if f["role"] in ("lecture", "factsheet", "compass", "old_exam")],
    "2_Uebungsfaelle_und_Sachverhalte": [f for f in files if f["role"] == "exercise"],
    "3_Offizielle_ZHAW_Loesungsskizzen": [f for f in files if f["role"] == "solution"],
}

for group_name, gfiles in groups.items():
    if not gfiles:
        continue
    writer = PdfWriter()
    added = 0
    for f in gfiles:
        try:
            print(f"  Lade & kombiniere: {f[\"name\"]}...")
            req = urllib.request.Request(f["url"], headers={"User-Agent": "Mozilla/5.0"})
            raw = urllib.request.urlopen(req, timeout=30).read()
            reader = PdfReader(io.BytesIO(raw))
            for page in reader.pages:
                writer.add_page(page)
            added += 1
        except Exception as e:
            print(f"  Überspringe {f[\"name\"]}: {e}")
    if added > 0:
        out_path = os.path.join(workdir, f"{title} - {group_name}.pdf".replace("/", "_"))
        with open(out_path, "wb") as out_f:
            writer.write(out_f)
        print(f"-> Lade Sammel-PDF ({added} Dokumente) zu NotebookLM hoch: {os.path.basename(out_path)}...")
        subprocess.run(["nlm", "source", "add", str(nb_id), "--file", out_path, "--wait"], check=False)

print(f"✅ Fertig! Dein Kurs \"{title}\" ist komplett in NotebookLM eingerichtet: https://notebooklm.google.com/")
'`;
}
