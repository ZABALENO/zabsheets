# ZABALENO – Google Sheets + Render

Webová aplikace ZABALENO používá Google Sheets jako databázi. Uživatelé se nepřihlašují do Google; přihlášení probíhá přímo v aplikaci a server na Renderu komunikuje s Google Sheets přes Service Account.

## Architektura

Browser → Render Web Service → Google Sheets API → Google Sheet

Google Service Account a `SHEET_ID` nejsou v klientském JavaScriptu.

## Render Environment Variables

Nastavte:

- `SHEET_ID` = ID cílové Google tabulky
- `JWT_SECRET` = dlouhý náhodný řetězec (nebo `generateValue` v Renderu)
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `PARTNER_EMAIL`
- `PARTNER_PASSWORD`
- `NODE_ENV=production`

## Render Secret File

Doporučený název:

`google-service-account.json`

Obsah musí být celý JSON Service Accountu stažený z Google Cloud.

Server jej načítá z:

`/etc/secrets/google-service-account.json`

`GOOGLE_SERVICE_ACCOUNT_JSON` není při použití Secret File potřeba.

## Google Sheet

Service Account musí být přidán ke Google Sheet jako Editor. Tabulka nemusí být veřejná.

Po prvním spuštění server automaticky vytvoří listy:

- `products`
- `orders`
- `sales`
- `tasks`
- `notifs`
- `settings`

Data jsou uložena v každém listu ve sloupci A jako ID a ve sloupci B jako JSON. Další sloupce slouží pro čitelnost.

## Lokální spuštění

```bash
yarn install
node server.js
```

Server očekává stejné environment variables jako Render.

## Bezpečnost

- Google Service Account private key nikdy nedávejte do GitHubu.
- Nepoužívejte veřejný Google Sheet s právem „Kdokoli s odkazem může upravovat“.
- Pokud byl Service Account JSON/private key zveřejněn nebo poslán do chatu, vytvořte nový key v Google Cloud a starý key zneplatněte.
