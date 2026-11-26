#!/usr/bin/env python3
"""verify_evidence.py — the evidence recorder a generated verify-<app> skill ships.

verification-skill-forge copies this file, byte for byte, into every verify skill it
generates (<verify skill>/scripts/verify_evidence.py) and `forge.py lint` fails a copy
that drifted. factory-conductor reads what it writes. stdlib only, offline.

Usage:
    python3 verify_evidence.py port    --instance I [--base 41000] [--span 1000]
                                                        # PORT: <n>  (claims it for I)
    python3 verify_evidence.py claim   --instance I --port N   # PORT: <n> | exit 3 if taken
    python3 verify_evidence.py release --instance I             # RELEASED: <n> ...
    python3 verify_evidence.py doctor  --instance I --ok|--fail --check NAME=pass|fail ...
                                        [--verifier ID] [--worktree W]
                                                        # DOCTOR: <path>
    python3 verify_evidence.py record  --instance I --feature F --verifier ID
                                        --result pass|fail --action TEXT --observed TEXT
                                        --side-effect TEXT [--side-effect TEXT ...]
                                        --artifact PATH [--artifact PATH ...] [--worktree W]
                                                        # EVIDENCE: <path>
    python3 verify_evidence.py record  --instance I --feature F --verifier ID
                                        --tier proved|bounded|property --tool NAME
                                        --clauses C<n> --cmd ARGV [--timeout SECS]
                                        [--mutant-patch DIFF --mutant-author verifier|forge]
                                        [--worktree W]  # PROOF: <tier> <path>

A proof record (--tier) is taken by running the proof tool here: ARGV is split with shlex
(no shell) and run under --timeout from the root of a clean checkout of the committed
HEAD, and the record is written only when it exits 0 on the same HEAD. A worktree whose
tracked files differ from HEAD (git status --porcelain --untracked-files=no is not
empty) exits 2 before any checkout or run, naming the changed paths; untracked files do
not count, and are not in the checkout. Its stdout and stderr are pinned as artifacts; nothing
the caller supplies stands in for them, so --result, --action, --observed, --side-effect
and --artifact are refused with --tier. The record is
<evidence dir>/<instance>/<feature-id>/<sha>/proof-<tier>-<tool>-<clause>.json, with the
evidence.json fields and artifact shape plus tier, tool, clauses, argv and exit_status.
--tool must be on its tier's list in TIER_TOOLS (proved: verus; bounded: kani; property:
proptest, hypothesis, fast-check, rapid) and --clauses must name exactly one clause.
ARGV must run that tool: runner_matches(tool, argv) holds only when argv starts with one
of the tool's runners in RUNNERS (verus: verus or cargo verus; hypothesis: pytest or
python -m pytest; and so on), after at most one leading wrapper from WRAPPERS (uv run,
npx, ...). argv[0] must be a bare name found on PATH, with no '/'. Any other ARGV exits 2
before any other check, and nothing runs.

A bounded or property pass alone proves little, since a check that tests nothing passes
too. So those tiers also take --mutant-patch (a diff that breaks the code) and
--mutant-author (who wrote it). The recorder checks out HEAD again into a second temporary
directory outside the worktree, applies the patch there with git apply, and runs the same
ARGV in that copy with the same timeout. The record is written only when the mutant run
exits non-zero and its output matches the tool's entry in FAILURE_SIGNATURES, so a mutant
that only breaks the build does not count. The patch and the mutant run's exit status,
stdout and stderr are pinned as artifacts too. The worktree is never touched and both
checkouts are always removed. The record stores cwd "." and ran_in "checkout": the runs
happened at the root of a checkout, not in the worktree. proved takes no mutant flags.

Where things go. Evidence lives under the evidence directory: $VERIFY_EVIDENCE_DIR when
set, else <git toplevel of --worktree (default: cwd)>/.verify. Each record is
<evidence dir>/<instance>/<feature-id>/<sha>/evidence.json; each doctor result is
<evidence dir>/<instance>/doctor/<sha>/doctor.json. <sha> is the HEAD commit of --worktree,
read with git: never a flag, so a record cannot name a head it was not taken from.
Artifacts are copied into the record's directory and pinned by sha256; a file that
already sits there is pinned where it is. Port claims and other per-instance run state
live under <evidence dir>/../.verify-run/, which cleanup may delete; nothing here ever
deletes evidence.

Exit 0 on success, 1 when a proof command did not exit 0 on the head or the mutant run
did not fail with the tool's signature, 2 on invalid input (a patch that does not apply
included), 3 when a port is taken by another instance. Every check runs before any write.
"""
import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import zlib

SCHEMA = "verify-evidence/v1"
ID_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*\Z")
INSTANCE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z")
SHA_RE = re.compile(r"^[0-9a-f]{40}\Z")
RESERVED = ("doctor", "findings")
TIERS = ("proved", "bounded", "property")
# The tools each proof tier accepts for --tool. A tool earns a tier by what its pass
# means: verus proves for all inputs, kani checks every input up to a stated bound, and
# the property tools sample inputs. CrossHair is not bounded: its bound is a time budget.
TIER_TOOLS = {
    "proved": ("verus",),
    "bounded": ("kani",),
    "property": ("proptest", "hypothesis", "fast-check", "rapid"),
}
# The commands that run each tool. A tier record counts only when its argv starts with
# one of these, so --tool cannot label a command that runs something else. A runner is
# matched as an exact positional prefix: no option may sit between its words.
# references/proof-tiers.md mirrors this table.
RUNNERS = {"verus": (("verus",), ("cargo", "verus")),
           "kani": (("kani",), ("cargo", "kani")),
           "hypothesis": (("pytest",), ("python", "-m", "pytest"),
                          ("python3", "-m", "pytest")),
           "proptest": (("cargo", "test"),),
           "fast-check": (("vitest",), ("jest",)),
           "rapid": (("go", "test"),)}
# Launchers that may come before a runner. At most one is stripped, and nothing (no flag)
# may sit between it and the runner.
WRAPPERS = (("uv", "run"), ("poetry", "run"), ("pdm", "run"), ("pipenv", "run"),
            ("hatch", "run"), ("pnpm", "exec"), ("yarn",), ("bunx",), ("npx",))
PYTHON_RE = re.compile(r"^python(3(\.\d+)?)?\Z")


def _runner_word(word):
    """A python interpreter name counts as python (python, python3, python3.12)."""
    return "python" if PYTHON_RE.match(word) else word


def runner_matches(tool, argv):
    """True when argv runs tool: after at most one leading wrapper, argv starts with one
    of RUNNERS[tool], word for word. An argv[0] with a '/' never matches, because a path
    names a file the caller chose, not the tool on PATH."""
    argv = list(argv)
    if not argv or "/" in argv[0]:
        return False
    rests = [argv] + [argv[len(w):] for w in WRAPPERS if tuple(argv[:len(w)]) == w]
    for rest in rests:
        if not rest or "/" in rest[0]:
            continue
        for runner in RUNNERS.get(tool, ()):
            head = rest[:len(runner)]
            if len(head) == len(runner) and \
                    [_runner_word(head[0])] + head[1:] == \
                    [_runner_word(runner[0])] + list(runner[1:]):
                return True
    return False


# What a tool's output holds when the property or proof itself failed, for the mutant
# run of a bounded or property record: every "require" pattern matches and no "reject"
# pattern does. These are heuristics over the tools' usual output. They exist to tell a
# failed check apart from a mutant that broke the build or crashed the harness, so each
# needs positive evidence of a failed check. references/proof-tiers.md mirrors this table.
FAILURE_SIGNATURES = {
    "kani": {"require": (r"VERIFICATION:- FAILED",),
             "reject": (r"error\[E\d+\]", r"could not compile")},
    "proptest": {"require": (r"test result: FAILED", r"minimal failing input"),
                 "reject": (r"error\[E\d+\]", r"could not compile")},
    "hypothesis": {"require": (r"Falsifying example", r"\b\d+ failed\b"),
                   "reject": (r"errors? during collection", r"ERROR collecting")},
    "fast-check": {"require": (r"Property failed after \d+ tests?",),
                   "reject": (r"Test suite failed to run", r"error TS\d+")},
    "rapid": {"require": (r"--- FAIL", r"\[rapid\] failed"),
              "reject": (r"\[build failed\]", r"\[setup failed\]")},
}
MUTANT_AUTHORS = ("verifier", "forge")
CLAUSE_RE = re.compile(r"^C[1-9][0-9]*\Z")
RUNTIME_ONLY = ("result", "action", "observed", "side_effect", "artifact")
MUTANT_TIERS = ("bounded", "property")


def _now():
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _fail(msg, code=2):
    sys.stderr.write("verify_evidence: %s\n" % msg)
    return code


def _git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True)


def head_sha(worktree):
    """The HEAD commit of worktree, or None."""
    r = _git(worktree, "rev-parse", "--verify", "HEAD^{commit}")
    sha = r.stdout.strip()
    return sha if r.returncode == 0 and SHA_RE.match(sha) else None


def evidence_dir(worktree):
    env = os.environ.get("VERIFY_EVIDENCE_DIR")
    if env:
        return os.path.abspath(env)
    r = _git(worktree, "rev-parse", "--show-toplevel")
    top = r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else worktree
    return os.path.join(os.path.abspath(top), ".verify")


def run_dir(worktree):
    """Per-instance run state (port claims): a sibling of the evidence directory."""
    return os.path.join(os.path.dirname(evidence_dir(worktree)), ".verify-run")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _write_json(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


# ── ports ────────────────────────────────────────────────────────────────────
def _lock_path(worktree, port):
    return os.path.join(run_dir(worktree), "ports", "%d.lock" % port)


def _holder(lock):
    try:
        with open(lock, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return None


def _bindable(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def claim_port(worktree, instance, port):
    """Claim port for instance. True when it is (now or already) ours, False when another
    instance holds it. The claim is an O_EXCL lock file, so two owners racing for the
    same port cannot both win."""
    lock = _lock_path(worktree, port)
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        return _holder(lock) == instance
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(instance + "\n")
    return True


def cmd_port(a):
    if not INSTANCE_RE.match(a.instance):
        return _fail("bad instance name %r" % a.instance)
    wt = os.path.abspath(a.worktree)
    start = a.base + zlib.crc32(a.instance.encode()) % a.span
    order = [a.base + (start - a.base + i) % a.span for i in range(a.span)]
    # A port the instance already holds wins over an earlier one that has freed since,
    # so every call names the port its server is on.
    d = os.path.join(run_dir(wt), "ports")
    held = {name for name in (os.listdir(d) if os.path.isdir(d) else [])
            if _holder(os.path.join(d, name)) == a.instance}
    for port in order:
        if "%d.lock" % port in held:
            print("PORT: %d" % port)
            return 0
    for port in order:
        lock = _lock_path(wt, port)
        if os.path.exists(lock) or not _bindable(port):
            continue
        if claim_port(wt, a.instance, port):
            print("PORT: %d" % port)
            return 0
    return _fail("no free port in [%d, %d)" % (a.base, a.base + a.span), 3)


def cmd_claim(a):
    if not INSTANCE_RE.match(a.instance):
        return _fail("bad instance name %r" % a.instance)
    wt = os.path.abspath(a.worktree)
    if claim_port(wt, a.instance, a.port):
        print("PORT: %d" % a.port)
        return 0
    return _fail("port %d is held by instance %s" % (a.port, _holder(_lock_path(wt, a.port))), 3)


def cmd_release(a):
    wt = os.path.abspath(a.worktree)
    d = os.path.join(run_dir(wt), "ports")
    released = []
    for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        path = os.path.join(d, name)
        if _holder(path) == a.instance:
            os.unlink(path)
            released.append(name.split(".")[0])
    print("RELEASED: %s" % (" ".join(released) or "none"))
    return 0


# ── records ──────────────────────────────────────────────────────────────────
def _instance_and_head(a):
    if not INSTANCE_RE.match(a.instance):
        return None, None, _fail("bad instance name %r" % a.instance)
    wt = os.path.abspath(a.worktree)
    sha = head_sha(wt)
    if sha is None:
        return None, None, _fail("%s is not a git work tree with a commit" % wt)
    return wt, sha, None


def cmd_doctor(a):
    wt, sha, err = _instance_and_head(a)
    if err is not None:
        return err
    checks = {}
    for item in a.check or []:
        name, _, value = item.partition("=")
        if not name or value not in ("pass", "fail"):
            return _fail("--check takes NAME=pass|fail, got %r" % item)
        checks[name] = value
    if not checks:
        return _fail("doctor needs at least one --check (process, version, port, auth)")
    ok = a.ok and all(v == "pass" for v in checks.values())
    path = os.path.join(evidence_dir(wt), a.instance, "doctor", sha, "doctor.json")
    _write_json(path, {"schema": SCHEMA, "kind": "doctor", "instance": a.instance,
                       "sha": sha, "ok": ok, "checks": checks, "verifier": a.verifier,
                       "captured_at": _now()})
    print("DOCTOR: %s %s" % ("ok" if ok else "red", path))
    return 0


def _record_target(a):
    """(wt, sha, err) after the checks every record shares: instance, head, feature."""
    wt, sha, err = _instance_and_head(a)
    if err is not None:
        return None, None, err
    if not ID_RE.match(a.feature) or a.feature in RESERVED:
        return None, None, _fail("bad feature id %r (lowercase kebab-case, not %s)"
                                 % (a.feature, " or ".join(RESERVED)))
    return wt, sha, None


def cmd_record(a):
    if a.tier is not None:
        return cmd_record_tier(a)
    wt, sha, err = _record_target(a)
    if err is not None:
        return err
    for name in ("verifier", "action", "observed"):
        if not (getattr(a, name) or "").strip():
            return _fail("--%s is required and cannot be blank" % name)
    effects = [s for s in (a.side_effect or []) if s.strip()]
    if not effects:
        return _fail("at least one --side-effect is required (write 'none: <why>' when the "
                     "feature has none): visible state alone is not proof")
    if not a.artifact:
        return _fail("at least one --artifact is required: the captured action and state")
    out = os.path.join(evidence_dir(wt), a.instance, a.feature, sha)
    names = [os.path.basename(os.path.abspath(x)) for x in a.artifact]
    dup = sorted({n for n in names if names.count(n) > 1})
    if dup:
        # Each artifact lands in the record's directory under its basename: two with one
        # name would overwrite each other and the first hash would no longer match.
        return _fail("artifacts share a file name (%s): rename one before recording"
                     % ", ".join(dup))
    owned = sorted({n for n in names if n in ("evidence.json", "doctor.json")
                    or n.startswith("proof-")})
    if owned:
        # The recorder writes these names itself: evidence.json would overwrite the
        # artifact, and a doctor.json or proof-* file beside the record would sit where the
        # conductor reads doctor and proof records, so a copied record could pose as one.
        return _fail("artifact name %s is the recorder's own (evidence.json, doctor.json, "
                     "proof-*): rename it before recording" % ", ".join(owned))
    for src in a.artifact:
        if not os.path.isfile(os.path.abspath(src)):
            return _fail("artifact %s does not exist" % os.path.abspath(src))
    os.makedirs(out, exist_ok=True)
    arts = []
    for src in a.artifact:
        src = os.path.abspath(src)
        if os.path.dirname(src) != out:
            dest = os.path.join(out, os.path.basename(src))
            shutil.copyfile(src, dest)
            src = dest
        arts.append({"path": os.path.basename(src), "sha256": sha256_file(src)})
    path = os.path.join(out, "evidence.json")
    _write_json(path, {"schema": SCHEMA, "kind": "evidence", "instance": a.instance,
                       "feature": a.feature, "sha": sha, "verifier": a.verifier,
                       "result": a.result, "action": a.action, "observed": a.observed,
                       "side_effects": effects, "artifacts": arts, "captured_at": _now()})
    print("EVIDENCE: %s %s" % (a.result, path))
    return 0


def _worktree_root(wt):
    r = _git(wt, "rev-parse", "--show-toplevel")
    top = r.stdout.strip()
    return os.path.abspath(top) if r.returncode == 0 and top else None


def cmd_record_tier(a):
    """A proof record: run the tool on the head, and write only on exit 0."""
    wt, sha, err = _record_target(a)
    if err is not None:
        return err
    given = ["--" + n.replace("_", "-") for n in RUNTIME_ONLY if getattr(a, n) is not None]
    if given:
        return _fail("%s cannot be used with --tier: a proof record holds only what the "
                     "recorder saw the tool do; drop them" % ", ".join(given))
    for flag, name in (("verifier", "verifier"), ("tool", "tool"), ("cmd", "proof_cmd")):
        if not (getattr(a, name) or "").strip():
            return _fail("--%s is required with --tier and cannot be blank" % flag)
    allowed = TIER_TOOLS[a.tier]
    if a.tool not in allowed:
        return _fail("--tool %r is not allowed for --tier %s: use %s, or record the proof "
                     "at the tier its tool earns" % (a.tool, a.tier, ", ".join(allowed)))
    # The runner check comes next, before any other: a --cmd that does not run --tool
    # is refused whatever else the call holds, and it never runs.
    try:
        argv = shlex.split(a.proof_cmd)
    except ValueError as e:
        return _fail("--cmd does not parse as a command line (%s): fix its quoting" % e)
    if not argv:
        return _fail("--cmd is required with --tier and cannot be blank")
    if not runner_matches(a.tool, argv):
        return _fail("--cmd runs %s, which is not a runner of --tool %s (%s): start --cmd "
                     "with one of them, by name on PATH, after at most one wrapper such "
                     "as uv run or npx" % (argv[0], a.tool, ", ".join(
                         " ".join(r) for r in RUNNERS[a.tool])))
    # One record proves one clause: a list, or nothing, would credit clauses the run
    # may not cover.
    named = [c for c in re.split(r"[\s,;]+", a.clauses or "") if c]
    if len(named) != 1:
        return _fail("--clauses %r names %d clauses: exactly one clause is required, such "
                     "as C1; record each clause separately" % (a.clauses or "", len(named)))
    if not CLAUSE_RE.match(a.clauses):
        return _fail("bad --clauses %r: name one contract clause id, such as C1"
                     % a.clauses)
    if a.timeout <= 0:
        return _fail("--timeout must be a positive number of seconds, got %d" % a.timeout)
    patch = None
    if a.tier not in MUTANT_TIERS:
        given = [f for f, n in (("--mutant-patch", "mutant_patch"),
                                ("--mutant-author", "mutant_author"))
                 if getattr(a, n) is not None]
        if given:
            return _fail("%s cannot be used with --tier %s: only bounded and property "
                         "records take a mutant; drop them" % (", ".join(given), a.tier))
    else:
        if not a.mutant_patch or a.mutant_author is None:
            return _fail("--tier %s needs --mutant-patch DIFF and --mutant-author "
                         "verifier|forge: a %s record counts only when the same command "
                         "fails on a recorded mutant of the code" % (a.tier, a.tier))
        if a.mutant_author not in MUTANT_AUTHORS:
            return _fail("--mutant-author %r: use %s"
                         % (a.mutant_author, " or ".join(MUTANT_AUTHORS)))
        try:
            with open(os.path.abspath(a.mutant_patch), "rb") as f:
                patch = f.read()
        except OSError as e:
            return _fail("cannot read --mutant-patch %s (%s): pass the diff file of the "
                         "mutant" % (a.mutant_patch, e))
        if not patch.strip():
            return _fail("--mutant-patch %s is empty: pass a diff that changes the code"
                         % a.mutant_patch)
    root = _worktree_root(wt)
    if root is None:
        return _fail("cannot find the git toplevel of %s" % wt)
    err = _refuse_dirty(root)
    if err is not None:
        return err
    copy = head = None
    try:
        # The mutant copy comes first, so a patch that does not apply exits 2 before
        # any command runs.
        if patch is not None:
            copy, err = _mutant_copy(root, sha, patch)
            if err is not None:
                return err
        head, err = _checkout(root, sha)
        if err is not None:
            return err
        run, err = _run_proof(argv, head, a.timeout)
        if err is not None:
            return err
        if run.returncode != 0:
            return _fail("%s exited %d on %s: nothing recorded; a proof tier needs the "
                         "tool to pass on the head" % (argv[0], run.returncode, sha[:12]), 1)
        mutant = None
        if copy is not None:
            mutant, err = _run_proof(argv, copy, a.timeout, "on the mutant ")
            if err is not None:
                return err
            if mutant.returncode == 0:
                return _fail("%s exited 0 on the mutant: nothing recorded; the check does "
                             "not catch the mutant, so strengthen it or write a mutant it "
                             "should catch" % argv[0], 1)
            missing = _signature_miss(a.tool, mutant.stdout + b"\n" + mutant.stderr)
            if missing:
                return _fail("%s exited %d on the mutant but its output %s: nothing "
                             "recorded; a mutant that breaks the build or the harness "
                             "proves nothing, so write one that makes the check itself "
                             "fail (see references/proof-tiers.md)"
                             % (argv[0], mutant.returncode, missing), 1)
        if head_sha(wt) != sha:
            return _fail("HEAD moved from %s while %s ran: nothing recorded; record again "
                         "on a fixed head" % (sha[:12], argv[0]), 1)
    finally:
        for d in (copy, head):
            if d is not None:
                shutil.rmtree(os.path.dirname(d), ignore_errors=True)
    out = os.path.join(evidence_dir(wt), a.instance, a.feature, sha)
    stem = "proof-%s-%s-%s" % (a.tier, a.tool, a.clauses)
    files = [("stdout", run.stdout), ("stderr", run.stderr)]
    if mutant is not None:
        files += [("mutant.patch", patch), ("mutant.exit", b"%d\n" % mutant.returncode),
                  ("mutant.stdout", mutant.stdout), ("mutant.stderr", mutant.stderr)]
    os.makedirs(out, exist_ok=True)
    arts = []
    for ext, data in files:
        name = "%s.%s" % (stem, ext)
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
        arts.append({"path": name, "sha256": hashlib.sha256(data).hexdigest()})
    path = os.path.join(out, stem + ".json")
    # kind stays "evidence" and result "pass" so the conductor's record check (sha,
    # artifacts, verifier) reads a proof record exactly as it reads evidence.json.
    doc = {"schema": SCHEMA, "kind": "evidence", "instance": a.instance,
           "feature": a.feature, "sha": sha, "verifier": a.verifier,
           "result": "pass", "tier": a.tier, "tool": a.tool,
           "clauses": [a.clauses], "argv": argv, "cwd": ".", "ran_in": "checkout",
           "timeout": a.timeout, "exit_status": run.returncode,
           "artifacts": arts, "captured_at": _now()}
    if mutant is not None:
        doc.update(mutant_author=a.mutant_author, mutant_exit_status=mutant.returncode)
    _write_json(path, doc)
    print("PROOF: %s %s" % (a.tier, path))
    return 0


def _run_proof(argv, cwd, timeout, where=""):
    """(CompletedProcess, None), or (None, exit code) once the reason is reported."""
    try:
        return subprocess.run(argv, cwd=cwd, capture_output=True, timeout=timeout), None
    except subprocess.TimeoutExpired:
        return None, _fail("%s did not finish %sin %d seconds: nothing recorded; raise "
                           "--timeout or narrow the proof" % (argv[0], where, timeout), 1)
    except OSError as e:
        return None, _fail("cannot run %s %s(%s): nothing recorded; check the tool is "
                           "installed and on PATH" % (argv[0], where, e), 1)


def _refuse_dirty(root):
    """None when no tracked file differs from HEAD, else the exit code once reported.
    Untracked files do not count: they are not in the checkout the proof runs in.
    GIT_OPTIONAL_LOCKS=0 stops git status from refreshing the worktree's index."""
    r = subprocess.run(["git", "-C", root, "status", "--porcelain", "--untracked-files=no"],
                       capture_output=True, text=True,
                       env=dict(os.environ, GIT_OPTIONAL_LOCKS="0"))
    if r.returncode != 0:
        return _fail("git status failed in %s (%s): nothing ran or was recorded"
                     % (root, r.stderr.strip()))
    paths = [line[3:] for line in r.stdout.splitlines() if line.strip()]
    if paths:
        return _fail("the worktree has tracked changes that are not committed: %s. "
                     "Nothing ran or was recorded; a proof runs on the committed head, so "
                     "commit or stash these changes and record again" % ", ".join(paths))
    return None


def _checkout(root, sha):
    """(dir, None): every tracked file of commit sha, checked out into a new temporary
    directory outside the worktree. (None, exit code) when it cannot be made; nothing is
    left behind. A private index is used, so the worktree and its index are only read.
    Unlike git archive, export-ignore in .gitattributes drops nothing."""
    tmp = tempfile.mkdtemp(prefix="verify-proof-")
    copy, done = os.path.join(tmp, "head"), False
    try:
        env = dict(os.environ, GIT_INDEX_FILE=os.path.join(tmp, "index"))
        for args in (("read-tree", sha),
                     ("checkout-index", "-a", "-f", "--prefix=%s%s" % (copy, os.sep))):
            r = subprocess.run(["git", "-C", root, *args], capture_output=True,
                               text=True, env=env)
            if r.returncode != 0:
                return None, _fail("cannot check out %s (git %s: %s): nothing recorded"
                                   % (sha[:12], args[0], r.stderr.strip()), 1)
        os.makedirs(copy, exist_ok=True)  # a commit with no files
        os.remove(os.path.join(tmp, "index"))
        done = True
        return copy, None
    finally:
        if not done:
            shutil.rmtree(tmp, ignore_errors=True)


def _mutant_copy(root, sha, patch):
    """(copy dir, None): a clean checkout of commit sha in a new temporary directory,
    with patch applied. (None, exit code) when it cannot be made; nothing is left behind.
    The worktree is only read, never written."""
    copy, err = _checkout(root, sha)
    if err is not None:
        return None, err
    tmp, done = os.path.dirname(copy), False
    try:
        diff = os.path.join(tmp, "mutant.patch")
        with open(diff, "wb") as f:
            f.write(patch)
        # The ceiling stops git apply from finding a repository above the copy, so the
        # patch applies to the copy's files as plain paths.
        r = subprocess.run(["git", "apply", "--whitespace=nowarn", diff], cwd=copy,
                           capture_output=True, text=True,
                           env=dict(os.environ, GIT_CEILING_DIRECTORIES=tmp))
        os.remove(diff)
        if r.returncode != 0:
            return None, _fail("--mutant-patch does not apply to %s (%s): nothing ran or "
                               "was recorded; make the diff against this commit with "
                               "paths from the repository root"
                               % (sha[:12], r.stderr.strip() or "git apply failed"))
        done = True
        return copy, None
    finally:
        if not done:
            shutil.rmtree(tmp, ignore_errors=True)


def _signature_miss(tool, output):
    """None when output matches tool's FAILURE_SIGNATURES entry, else what is wrong."""
    text = output.decode("utf-8", "replace")
    sig = FAILURE_SIGNATURES[tool]
    for pat in sig["require"]:
        if not re.search(pat, text):
            return "lacks %r, which a failed %s check prints" % (pat, tool)
    for pat in sig["reject"]:
        if re.search(pat, text):
            return "matches %r, which means the build or harness failed" % pat
    return None


def main(argv=None):
    p = argparse.ArgumentParser(prog="verify_evidence.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    parsers = {}
    for name in ("port", "claim", "release", "doctor", "record"):
        s = parsers[name] = sub.add_parser(name)
        s.add_argument("--instance", required=True)
        s.add_argument("--worktree", default=".")
        if name == "port":
            s.add_argument("--base", type=int, default=41000)
            s.add_argument("--span", type=int, default=1000)
        if name == "claim":
            s.add_argument("--port", type=int, required=True)
        if name == "doctor":
            g = s.add_mutually_exclusive_group(required=True)
            g.add_argument("--ok", action="store_true")
            g.add_argument("--fail", action="store_true")
            s.add_argument("--check", action="append")
            s.add_argument("--verifier")
        if name == "record":
            s.add_argument("--feature", required=True)
            s.add_argument("--verifier", required=True)
            s.add_argument("--result", choices=("pass", "fail"))
            s.add_argument("--action")
            s.add_argument("--observed")
            s.add_argument("--side-effect", action="append")
            s.add_argument("--artifact", action="append")
            s.add_argument("--tier", choices=TIERS)
            s.add_argument("--tool")
            s.add_argument("--clauses")
            s.add_argument("--cmd", dest="proof_cmd")
            s.add_argument("--timeout", type=int, default=900)
            s.add_argument("--mutant-patch")
            s.add_argument("--mutant-author")
    a = p.parse_args(argv)
    if a.cmd == "record" and a.tier is None:
        # A runtime record keeps its required flags; only --tier lifts them.
        missing = ["--" + n for n in ("result", "action", "observed")
                   if getattr(a, n) is None]
        if missing:
            parsers["record"].error("the following arguments are required: %s"
                                    % ", ".join(missing))
        stray = [f for f, n in (("--tool", "tool"), ("--clauses", "clauses"),
                                ("--cmd", "proof_cmd"), ("--mutant-patch", "mutant_patch"),
                                ("--mutant-author", "mutant_author"))
                 if getattr(a, n) is not None]
        if stray:
            parsers["record"].error("%s only apply to a proof record: add --tier"
                                    % ", ".join(stray))
    return {"port": cmd_port, "claim": cmd_claim, "release": cmd_release,
            "doctor": cmd_doctor, "record": cmd_record}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
