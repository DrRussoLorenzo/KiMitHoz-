# Admin fiók és vezérlőpult

1. A helyi `.env` fájlban állítsd be az `ADMIN_EMAIL` és `ADMIN_PASSWORD` változókat (a jelszó legalább 8 karakter legyen). A `.env.example` mintát ad; ne tölts fel valódi jelszót a verziókezelőbe.
2. Indítsd újra a szervert. Az első indításkor az alkalmazás létrehozza az admin fiókot; ezután az admin a szokásos bejelentkezési oldalon, e-mail-címmel és jelszóval léphet be.
3. A belépés után a bal oldali menü Admin panel pontja nyitja meg a kezelőfelületet, vagy közvetlenül megnyitható a `/admin.html` cím.

Az adatbázis egyedi indexe legfeljebb egy admin szerepkörű felhasználót enged. Az admin API minden végpontja a szerveren ellenőrzi a bejelentkezést és az admin szerepkört; az admin fiók a panelen nem törölhető, és a felhasználókezelőből nem adható további admin szerepkör. A fiók létrehozása után az admin jelszavát ne tartsd meg az alkalmazás konfigurációjában, kivéve ha egy még nem létező admin fiókot kell létrehozni.

A panel a felhasználói fiókokat, bulikat, értesítéseket és buli-chatüzeneteket kezeli (listázás/keresés, létrehozás, szerkesztés, törlés). A törlés visszafordíthatatlan; a felhasználó vagy buli törlése a hozzá kapcsolódó adatokat is eltávolítja.
A panel az összes felhasználói fiókot, bulit, bulihoz tartozó tételt, értesítést és chatüzenetet kezeli (keresés, lapozható listázás, létrehozás, szerkesztés, törlés). A felhasználó profilja, beállításai, kapcsolatai és jelszava szerkeszthető; normál felhasználó kitiltható vagy feloldható. A kitiltás azonnal érvényes a bejelentkezésre és minden érvényes munkamenetre is. Az admin fiók nem tiltható ki és nem törölhető.

A törlés visszafordíthatatlan; a felhasználó vagy buli törlése a hozzá kapcsolódó adatokat is eltávolítja. A panel 50-es oldalakon jeleníti meg az adatokat, ezért az oldalak végiglapozásával a teljes adatbázis áttekinthető.

## Regisztrációs ellenőrzés

A felhasználó a regisztrációs űrlapon megadja az adatait és feltölti a személyi igazolvány, illetve az arcképét. A kérelmeket az admin panel „Regisztrációk ellenőrzése” menüpontjában lehet megtekinteni, elfogadni vagy elutasítani. SMTP-beállítás nem szükséges. A döntés után a felhasználó bejelentkezéskor kap visszajelzést; elfogadás esetén a főoldalon is megjelenik az értesítés. A képek a nem publikus `private/verification/` mappában vannak, csak admin API-n keresztül érhetők el, és az elbírálás után törlődnek.
