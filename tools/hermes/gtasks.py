#!/usr/bin/env python3
"""gtasks : Google Tasks et Agenda en ligne de commande, pour Hermes (remplace google_tasks.py de Jarvis).

Les identifiants vivent HORS de GitHub : ~/.hermes/google/client_secret.json et tokens.json (droits 600).
Usage :
  gtasks lists                                   listes de tâches et tâches ouvertes (JSON)
  gtasks add "Titre" [--due AAAA-MM-JJ] [--list "Nom"] [--notes "texte"]
  gtasks done <id_liste> <id_tâche>
  gtasks events [--days 7]                       événements de l'agenda
  gtasks event-add "Titre" --start 2026-10-25T14:00:00 --end 2026-10-25T15:00:00 [--description "..."]
"""
import argparse, json, os, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path(os.environ.get("HERMES_GOOGLE_DIR", Path.home() / ".hermes" / "google"))
TOKENS = HOME / "tokens.json"
SCOPES = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/tasks"]


def service(name, version):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    if not TOKENS.exists():
        sys.exit(f"Google non connecté : {TOKENS} absent.")
    data = json.loads(TOKENS.read_text(encoding="utf-8"))
    creds = Credentials(token=data["access_token"], refresh_token=data.get("refresh_token"), token_uri=data["token_uri"],
                        client_id=data["client_id"], client_secret=data["client_secret"], scopes=data.get("scopes") or SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        data["access_token"] = creds.token
        TOKENS.write_text(json.dumps(data), encoding="utf-8")
        os.chmod(TOKENS, 0o600)
    return build(name, version, credentials=creds, cache_discovery=False)


def out(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="gtasks")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("lists")
    a = sub.add_parser("add"); a.add_argument("title"); a.add_argument("--due"); a.add_argument("--list", default="Mes tâches"); a.add_argument("--notes", default="")
    d = sub.add_parser("done"); d.add_argument("list_id"); d.add_argument("task_id")
    e = sub.add_parser("events"); e.add_argument("--days", type=int, default=7)
    ea = sub.add_parser("event-add"); ea.add_argument("summary"); ea.add_argument("--start", required=True); ea.add_argument("--end", required=True); ea.add_argument("--description", default="")
    args = p.parse_args()

    if args.cmd == "lists":
        s = service("tasks", "v1")
        res = []
        for tl in s.tasklists().list().execute().get("items", []):
            items = s.tasks().list(tasklist=tl["id"], showCompleted=False, showHidden=False).execute().get("items", [])
            res.append({"id": tl["id"], "title": tl["title"], "tasks": [
                {"id": i["id"], "title": i["title"], "due": i.get("due"), "notes": i.get("notes", "")} for i in items]})
        out(res)
    elif args.cmd == "add":
        s = service("tasks", "v1")
        lists = s.tasklists().list().execute().get("items", [])
        lid = next((t["id"] for t in lists if t["title"] == args.list), None) or (lists[0]["id"] if lists else None)
        if lid is None:
            lid = s.tasklists().insert(body={"title": args.list}).execute()["id"]
        body = {"title": args.title}
        if args.due:
            body["due"] = f"{args.due}T00:00:00.000Z"
        if args.notes:
            body["notes"] = args.notes
        r = s.tasks().insert(tasklist=lid, body=body).execute()
        out({"created": r["id"], "title": r["title"], "list": lid})
    elif args.cmd == "done":
        s = service("tasks", "v1")
        t = s.tasks().get(tasklist=args.list_id, task=args.task_id).execute()
        t["status"] = "completed"
        s.tasks().update(tasklist=args.list_id, task=args.task_id, body=t).execute()
        out({"done": args.task_id})
    elif args.cmd == "events":
        s = service("calendar", "v3")
        now = datetime.now(timezone.utc)
        r = s.events().list(calendarId="primary", timeMin=now.isoformat(), timeMax=(now + timedelta(days=args.days)).isoformat(),
                            singleEvents=True, orderBy="startTime", maxResults=50).execute()
        out([{"summary": x.get("summary"), "start": x["start"].get("dateTime") or x["start"].get("date"),
              "end": x["end"].get("dateTime") or x["end"].get("date")} for x in r.get("items", [])])
    elif args.cmd == "event-add":
        s = service("calendar", "v3")
        tz = "Europe/Paris"
        r = s.events().insert(calendarId="primary", body={"summary": args.summary, "description": args.description,
            "start": {"dateTime": args.start, "timeZone": tz}, "end": {"dateTime": args.end, "timeZone": tz}}).execute()
        out({"created": r["id"], "link": r.get("htmlLink")})


if __name__ == "__main__":
    main()
