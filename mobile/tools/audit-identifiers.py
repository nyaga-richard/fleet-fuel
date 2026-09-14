#!/usr/bin/env python3
"""
Undefined-identifier audit for the Fleet Fuel mobile app.

Catches the runtime class "ReferenceError: Property 'X' doesn't exist"
(called but never imported/defined) that bundlers cannot detect, e.g.:
  - a component used but dropped from the import list
  - a renamed helper whose old call-site survived (the pendingOps bug)

Run before every commit:  python3 mobile/tools/audit-identifiers.py
Exit 0 = clean, exit 1 = problems found.
"""
import re, glob, sys, os

ROOT = os.path.join(os.path.dirname(__file__), '..')
KEYWORDS = {'if','else','return','catch','for','while','switch','do','try','new','typeof',
  'instanceof','delete','void','throw','async','await','yield','super','constructor','function',
  'class','import','export','default','from','of','in','case','break','continue'}
GLOBALS = {'require','module','exports','console','Promise','Math','Number','String','Boolean',
  'Array','Object','JSON','Date','Intl','isNaN','parseInt','parseFloat','setTimeout','setInterval',
  'clearTimeout','clearInterval','clearImmediate','setImmediate','fetch','NaN','undefined','global',
  'window','React','Set','Map','Symbol','encodeURIComponent','decodeURIComponent','Error','true','false','null'}
# Words that appear ONLY inside JSX prose sentences (never as code identifiers in
# files where they're not already defined). If a file declares/imports the name,
# it lands in `defined` from that — this list only masks prose-only occurrences.
PROSE_ONLY = {'REJECTED','cause','automatically','received','change','CONFIGURED','request','first'}

def strip_noncode(code):
    code = re.sub(r"(\w)'(\w)", r"\1’\2", code)              # You're → JSX-text apostrophe
    code = re.sub(r"//[^\n]*", "", code)
    code = re.sub(r"/\*.*?\*/", "", code, flags=re.S)
    code = re.sub(r"'(?:[^'\\]|\\.)*'", "''", code)
    code = re.sub(r'"(?:[^"\\]|\\.)*"', '""', code)
    code = re.sub(r"`(?:[^`\\]|\\.)*`", "``", code)
    # JSX prose nodes only: '>' not from '=>', content has no code punctuation
    code = re.sub(r"(?<!=)>([^<>{};()<]{0,300})<(?!=)", "><", code)
    return code

def collect_defined(code):
    defined = set(KEYWORDS) | set(GLOBALS) | PROSE_ONLY
    for m in re.finditer(r"import\s+([^;]+?)\s+from\s+", code):
        clause = m.group(1).strip()
        for g in re.finditer(r"\{([^}]*)\}", clause):
            for name in g.group(1).split(','):
                n = name.strip().split(' as ')[-1].strip()
                if re.match(r"^[A-Za-z_$][\w$]*$", n): defined.add(n)
        outside = re.sub(r"\{[^}]*\}", " ", clause)
        for part in outside.split(','):
            part = part.strip()
            mm = re.match(r"^\*\s+as\s+(\w+)$", part)
            if mm: defined.add(mm.group(1)); continue
            if re.match(r"^[A-Za-z_$][\w$]*$", part): defined.add(part)
    for m in re.finditer(r"\b(?:function|class)\s+([A-Za-z_$][\w$]*)", code):
        defined.add(m.group(1))
    for m in re.finditer(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", code):
        defined.add(m.group(1))
    for m in re.finditer(r"\b(?:const|let|var)\s*\[([^\]]+)\]\s*=", code):
        for name in m.group(1).split(','):
            n = name.strip().split(':')[0].split(' = ')[0].strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", n): defined.add(n)
    for m in re.finditer(r"\b(?:const|let|var)\s*\{([^}]+)\}\s*=", code):
        for name in m.group(1).split(','):
            n = name.strip().split(':')[-1].split(' = ')[0].strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", n): defined.add(n)
    for m in re.finditer(r"\(\s*([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\s*\)\s*=>", code):
        for p in m.group(1).split(','): defined.add(p.strip())
    for m in re.finditer(r"\(\s*\{([^}]+)\}\s*\)?\s*=>", code):
        for name in m.group(1).split(','):
            n = name.strip().split(':')[-1].split(' = ')[0].strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", n): defined.add(n)
    for m in re.finditer(r"\bfunction\s*\w*\s*\(([^)]*)\)", code):
        for p in m.group(1).split(','):
            n = p.strip().lstrip('{').rstrip('}').split(':')[-1].split(' = ')[0].strip()
            if re.match(r"^[A-Za-z_$][\w$]*$", n): defined.add(n)
    for m in re.finditer(r"\bcatch\s*\(\s*\{?([A-Za-z_$][\w$]*)", code):
        defined.add(m.group(1))
    for m in re.finditer(r"(?:\bof\b|\bin\b)\s+([A-Za-z_$][\w$]*)", code):
        defined.add(m.group(1))
    return defined

def main():
    files = sorted(glob.glob(os.path.join(ROOT, 'app', '**', '*.js'), recursive=True)
                 + glob.glob(os.path.join(ROOT, 'src', '**', '*.js'), recursive=True))
    problems = []
    for f in files:
        code = strip_noncode(open(f).read())
        defined = collect_defined(code)
        called = set(re.findall(r"(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(", code))
        # JSX component tags (<Icon, <Screen, …) are runtime identifier
        # references bundlers cannot check — an undefined component must fail
        # the audit here, not as a ReferenceError on device. Uppercase-only
        # avoids matching `a < b` comparisons.
        called |= set(re.findall(r"<([A-Z][A-Za-z0-9_]*)", code))
        missing = sorted(c for c in called if c not in defined)
        if missing:
            problems.append((os.path.relpath(f, ROOT), missing))
    for f, miss in problems: print(f"{f}: UNDEFINED CALLS → {miss}")
    if problems:
        print("AUDIT FAILED")
        sys.exit(1)
    print("AUDIT CLEAN — every called identifier is defined or imported")

if __name__ == '__main__':
    main()
