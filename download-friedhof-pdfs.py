"""Download all Friedhofsgebühren source PDFs and zip them."""
import os, urllib.request, zipfile

DIR = "friedhof-pdfs"
os.makedirs(DIR, exist_ok=True)

FILES = {
    "01-berlin-broschuere.pdf":
        "https://www.berlin.de/sen/uvk/_assets/natur-gruen/stadtgruen/friedhoefe-und-begraebnisstaetten/grabstaetten-und-gebuehren/broschuere_fhinberlin.pdf",
    "06-stuttgart-gebuehrenverzeichnis.pdf":
        "https://www.stuttgart.de/medien/ibs/7-3-anlage.pdf",
    "15-duisburg-gebuehrensatzung-2025.pdf":
        "https://www.duisburg-friedhof.de/Bilder/Downloads/SWBD.08%20Friedhofsgeb%C3%BChrensatzung%202025.pdf",
    "15-duisburg-gebuehrensatzung-2026.pdf":
        "https://a.storyblok.com/f/312000/x/8c8854b032/swbd-08-friedhofsgebuhrensatzung-2026.pdf",
    "16-bielefeld-gebuehrensatzung.pdf":
        "https://www.bielefeld.de/sites/default/files/datei/2024/Gebuehrensatzung-Friedhoefe.pdf",
    "16-bielefeld-friedhofssatzung.pdf":
        "https://www.bielefeld.de/sites/default/files/datei/2024/Friedhofssatzung_130724n.pdf",
    "18-muenster-gebuehren-2024.pdf":
        "https://www.stadt-muenster.de/fileadmin/user_upload/stadt-muenster/67_gruen/pics/Friedhoefe/pdf/friedhoefe_gebuehren_10_2024.pdf",
    "18-muenster-bdst-nrw-vergleich.pdf":
        "https://www.sauerbier-bestattungshaus.de/sites/default/files/gebuehrensatzung_nrw_vergleich.pdf",
    "19-karlsruhe-gebuehrensatzung.pdf":
        "https://www.karlsruhe.de/fileadmin/user_upload/01_Stadt_Rathaus/013_Verwaltung_und_Stadtpolitik/Stadtrecht/7_OEffentliche_Einrichtungen__Wirtschaftsfoerderung/7-9_Friedhofsgebuehrensatzung.pdf",
    "19-karlsruhe-gebuehrenverzeichnis-2025.pdf":
        "https://www.friedhof-karlsruhe.de/fileadmin/user_upload/Anlage_1a_Gebuehrenverzeichnis_2025.pdf",
    "20-mannheim-gebuehrensatzung.pdf":
        "https://www.mannheim.de/sites/default/files/page/2854/s07-04.pdf",
    "20-mannheim-aenderungssatzung.pdf":
        "https://www.mannheim.de/sites/default/files/B025%20Satzung%20zur%20%C3%84nderung%20der%20Geb%C3%BChrensatzung%20im%20Bestattungswesen.pdf",
}

print(f"Downloading {len(FILES)} PDFs...")
for name, url in FILES.items():
    path = os.path.join(DIR, name)
    try:
        urllib.request.urlretrieve(url, path)
        size = os.path.getsize(path)
        print(f"  OK  {name} ({size:,} bytes)")
    except Exception as e:
        print(f"  FAIL {name}: {e}")

md = "funeral-pricing-sources.md"
if os.path.exists(md):
    import shutil
    shutil.copy(md, os.path.join(DIR, md))
    print(f"  OK  {md}")

zipname = "friedhof-quellen.zip"
with zipfile.ZipFile(zipname, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(DIR):
        for f in files:
            fp = os.path.join(root, f)
            zf.write(fp)

print(f"\nDone: {zipname} ({os.path.getsize(zipname):,} bytes)")
