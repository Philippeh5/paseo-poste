# Mini-PC (Windows) : ouvrier, plus un second poste

Depuis la mise en place de la synchro à la minute, il n'y a **qu'un seul poste de commande** : Oracle
(`http://<TAILSCALE_IP>:7070`, allumé H24, il voit les deux machines). Le mini-PC reste un **ouvrier** :

- le **daemon Paseo** du mini-PC continue de tourner (il exécute les sessions du mini-PC) ;
- le **tunnel inverse SSH vers Oracle** (Oracle `127.0.0.1:6768` = daemon du mini-PC) n'est pas touché : il n'est géré ni par ce dépôt
  ni par `start-poste.ps1` (créé à la main). Le script journalise seulement s'il est présent ;
- l'**ancien dashboard** du mini-PC n'est plus lancé. À la place, `tools/redirect-poste.mjs` répond sur le port 7070 du mini-PC par une
  redirection vers Oracle (les anciens favoris `http://<TAILSCALE_IP>:7070` mènent donc au bon poste) ;
- la **synchro GitHub** tourne toutes les minutes, dans les deux sens, via la tâche planifiée `PosteSyncGitHub`
  (sans fenêtre : `wscript.exe` + lanceur `.vbs` masqué). Messages de commit lisibles : `sync mini-pc : a.js, b.js (+2 autres) · +12 −3`.
  Un problème qui dure plus de 10 minutes est visible dans `D:\Projets\SYNC-PROBLEMES.log` ; l'alerte Telegram part d'Oracle (le mini-PC n'a pas de
  configuration de notification : il n'envoie rien).

## À faire une seule fois (PowerShell, sur le mini-PC)

```powershell
# 1. Arrêter l'ancien poste : uniquement le processus node qui ÉCOUTE sur 7070 et dont la ligne de commande contient server.mjs
#    (start-dashboard.ps1 le lance depuis le dossier dashboard : « node server.mjs », ou « …\dashboard\server.mjs »)
$old = Get-NetTCPConnection -LocalPort 7070 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" } | Where-Object { $_.CommandLine -like '*server.mjs*' }
$old | Select-Object ProcessId, CommandLine           # contrôle : ne doit montrer que l'ancien dashboard
$old | ForEach-Object { Stop-Process -Id $_.ProcessId }   # jamais « Stop-Process -Name node » (le daemon Paseo est aussi du node)

# 2. Récupérer les nouveaux fichiers
git -C D:\Projets\paseo-poste pull

# 3. Installer la synchro à la minute (remplace l'ancienne tâche de synchro, quel que soit son nom)
pwsh -File D:\Projets\paseo-poste\tools\install-sync-task.ps1

# 4. Démarrer la redirection (le daemon Paseo déjà lancé n'est pas relancé)
pwsh -File D:\Projets\paseo-poste\tools\start-poste.ps1
```

Si `pwsh` n'existe pas, remplacer par `powershell -ExecutionPolicy Bypass -File …`.

## Vérifier

```powershell
Get-ScheduledTaskInfo -TaskName PosteSyncGitHub | Format-List LastRunTime, LastTaskResult, NextRunTime   # LastTaskResult = 0
Get-Content D:\Projets\.gh-sync.log -Tail 20            # une ligne seulement quand quelque chose change
Get-Content D:\Projets\SYNC-PROBLEMES.log -Tail 10      # vide ou ancien = tout va bien
Get-Content D:\Projets\paseo-poste\.foreman\start-poste.log -Tail 10   # daemon ok, tunnel présent, redirection :7070 ok
curl.exe -sI http://127.0.0.1:7070/                     # HTTP/1.1 302 + Location: http://<TAILSCALE_IP>:7070/
Get-NetTCPConnection -LocalPort 6767 -State Listen      # le daemon Paseo tourne toujours
```

Côté Oracle : `http://<TAILSCALE_IP>:7070` doit toujours montrer les deux machines (`oracle` et `local` = mini-PC).

## Retour arrière

`Unregister-ScheduledTask -TaskName PosteSyncGitHub -Confirm:$false` retire la synchro. Pour relancer l'ancien dashboard à la main (déconseillé,
deux postes prêtent à confusion) : `pwsh -File D:\Projets\paseo-poste\dashboard\start-dashboard.ps1` après avoir arrêté la redirection
(même méthode que l'étape 1, avec `redirect-poste.mjs`).

## Notes

- Prérequis : Git for Windows (`bash.exe`), `gh` connecté (`gh auth status`) : en mode branche (`paseo-poste`), c'est `gh` qui lit la CI
  pour fusionner `sync/<WINDOWS_HOSTNAME>` dans `main`. Sans lui, `SYNC-PROBLEMES.log` indique « lecture de la CI impossible ».
- Le lanceur copie `gh-sync.sh` vers `.foreman\gh-sync.run.sh` avant chaque passage : la synchro met `paseo-poste` à jour et ne réécrit jamais
  le script pendant qu'il tourne.
