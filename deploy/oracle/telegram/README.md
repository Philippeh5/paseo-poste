# Compte assistant Telegram — Guide de mise en place

## Qu'est-ce que le compte assistant ?

Le **compte assistant** est la session Telegram de Philippe lui-même, gérée par la bibliothèque [GramJS](https://gram.js.org/) (`npm telegram`). Contrairement aux bots (Bot API), un compte utilisateur peut :
- créer des groupes et des supergroup-forum,
- créer de nouveaux bots via @BotFather,
- inviter des comptes dans des groupes.

Les bots ainsi créés sont ensuite utilisés par le dashboard en mode Bot API (tokens seulement) pour envoyer leurs messages quotidiens — le compte assistant n'est plus sollicité en fonctionnement normal.

---

## Prérequis : créer une application Telegram

1. Va sur **<https://my.telegram.org>** et connecte-toi avec le numéro de téléphone de Philippe.
2. Clique sur **"API development tools"**.
3. Crée une nouvelle application (nom et plateforme au choix).
4. Note l'**api_id** (entier) et l'**api_hash** (chaîne hex).

> [!CAUTION]
> L'`api_hash` est un secret équivalent à un mot de passe. Ne le partage jamais, ne l'écris pas dans un fichier non protégé.

---

## Les 3 étapes de connexion (à faire une seule fois)

### Étape 1 — Envoi du code de vérification

```bash
export PATH=$HOME/.local/node/bin:$PATH
node tools/tg-login.mjs --api-id <api_id> --api-hash <api_hash> --phone +336XXXXXXXX
```

→ Telegram envoie un code à 5 chiffres dans l'application Telegram de Philippe.  
→ La commande affiche : `Code envoyé dans Telegram. Lance : node tools/tg-login.mjs --code 12345`

### Étape 2 — Saisie du code

```bash
node tools/tg-login.mjs --code 12345
```

Si Philippe a activé la **vérification en deux étapes** (mot de passe 2FA), la commande répond « Mot de passe 2FA requis » (code de sortie 2, la connexion en attente est conservée). Relance-la avec le mot de passe fourni **par fichier ou par variable d'environnement — jamais en argument** (il finirait dans l'historique du shell) :

```bash
# Option A : fichier créé vide en 600, puis rempli avec un éditeur (le mot de passe n'apparaît dans aucune commande)
install -m 600 /dev/null ~/tg2fa.txt && nano ~/tg2fa.txt
node tools/tg-login.mjs --code 12345 --password-file ~/tg2fa.txt
shred -u ~/tg2fa.txt

# Option B : variable d'environnement (à exporter sans l'écrire dans l'historique, ex. via un gestionnaire de secrets)
TG_2FA_PASSWORD="$(cat ~/tg2fa.txt)" node tools/tg-login.mjs --code 12345
```

→ La commande affiche : `Connecté en tant que Philippe (@username)`  
→ La session est sauvegardée dans `~/.config/paseo/tg-user.session` (mode 600).

### Étape 3 — Créer les bots du poste

```bash
node tools/tg-setup.mjs bots [--prefix poste_ph]
```

→ Dialogue avec @BotFather pour créer les 7 bots (vigie, relecteur, bâtisseur…).  
→ Les tokens sont écrits dans `~/.config/paseo/telegram-bots.env` (mode 600) dès réception, bot par bot : relancer la commande saute les bots déjà créés et, si une panne a interrompu la configuration d'un bot (photo, description), ne refait que cette configuration. Pour voir le plan sans rien envoyer : `node tools/tg-setup.mjs bots --dry-run`.

---

## Créer un groupe pour un projet

```bash
node tools/tg-setup.mjs group "NomDuProjet"
```

→ Crée le supergroupe forum `NomDuProjet · Poste` avec 4 topics et tous les bots comme admins.  
→ Affiche le JSON `{ "chatId": "-100...", "topics": { ... } }` à copier dans la config du projet.

---

## Vérifier / réinitialiser la session

```bash
node tools/tg-login.mjs --status     # qui est connecté ?
node tools/tg-login.mjs --logout     # déconnecte côté Telegram et supprime la session locale (tg-user.json est conservé)
```

---

## Où sont stockés les secrets ?

| Fichier | Contenu | Permissions |
|---------|---------|-------------|
| `~/.config/paseo/tg-user.json` | api_id, api_hash, numéro de téléphone | 600 |
| `~/.config/paseo/tg-user.session` | StringSession GramJS (= accès complet au compte) | 600 |
| `~/.config/paseo/tg-login-pending.json` | phoneCodeHash + session temporaire du login en cours (expire après 10 min) | 600 |
| `~/.config/paseo/telegram-bots.env` | Tokens des 7 bots | 600 |

Le dossier peut être surchargé via la variable `TG_USER_DIR`.

---

## Risques et précautions

> [!WARNING]
> **La session = accès total au compte Telegram de Philippe.** Toute personne ayant accès à `tg-user.session` peut lire tous les messages, envoyer des messages, etc.

- Les fichiers sont en mode **600** (lecture/écriture propriétaire uniquement).
- Les agents autonomes du poste sont **formellement interdits** de lire ces fichiers (garde-fous dans `dashboard/lib/guardrails.mjs` et `tools/guard-hook.mjs`).
- Ne jamais exécuter `printenv` ni `cat ~/.config/paseo/*`. L'étape 1 prend `--api-hash` en argument (c'est imposé par le mode non interactif) : il reste donc dans l'historique du shell de la session qui l'a lancée ; le mot de passe 2FA, lui, ne passe jamais en argument.
- En cas de compromission suspectée : `node tools/tg-login.mjs --logout` puis révoquer la session sur <https://my.telegram.org> → Sessions.
