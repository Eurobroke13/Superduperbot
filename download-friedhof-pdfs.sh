#!/bin/bash
# Downloads all Friedhofsgebühren PDFs/documents and zips them.
# Run locally (not in the cloud environment — .de domains are blocked there).

set -e
DIR="friedhof-pdfs"
mkdir -p "$DIR"

declare -A URLS=(
  # Berlin
  ["01-berlin-broschuere.pdf"]="https://www.berlin.de/sen/uvk/_assets/natur-gruen/stadtgruen/friedhoefe-und-begraebnisstaetten/grabstaetten-und-gebuehren/broschuere_fhinberlin.pdf"

  # Hamburg — no direct PDF; main page saved as reference
  # München — no direct PDF; Satzung 801 is HTML

  # Köln — no direct PDF in file

  # Frankfurt — no direct PDF in file

  # Stuttgart
  ["06-stuttgart-gebuehrenverzeichnis.pdf"]="https://www.stuttgart.de/medien/ibs/7-3-anlage.pdf"

  # Düsseldorf — HTML Ortsrecht

  # Dortmund — no direct PDF in file

  # Essen — no direct PDF in file

  # Leipzig — no direct PDF in file

  # Dresden — no direct PDF in file

  # Hannover — no direct PDF in file

  # Nürnberg — no direct PDF in file

  # Bremen
  ["14-bremen-gebuehrenordnung.pdf"]="https://www.transparenz.bremen.de/sixcms/detail.php?gsid=bremen203.c.310343.de&template=00_html_to_pdf_d"

  # Duisburg
  ["15-duisburg-gebuehrensatzung-2025.pdf"]="https://www.duisburg-friedhof.de/Bilder/Downloads/SWBD.08%20Friedhofsgeb%C3%BChrensatzung%202025.pdf"
  ["15-duisburg-gebuehrensatzung-2026.pdf"]="https://a.storyblok.com/f/312000/x/8c8854b032/swbd-08-friedhofsgebuhrensatzung-2026.pdf"

  # Bielefeld
  ["16-bielefeld-gebuehrensatzung.pdf"]="https://www.bielefeld.de/sites/default/files/datei/2024/Gebuehrensatzung-Friedhoefe.pdf"
  ["16-bielefeld-friedhofssatzung.pdf"]="https://www.bielefeld.de/sites/default/files/datei/2024/Friedhofssatzung_130724n.pdf"

  # Bonn — HTML Ortsrecht page

  # Münster
  ["18-muenster-gebuehren-2024.pdf"]="https://www.stadt-muenster.de/fileadmin/user_upload/stadt-muenster/67_gruen/pics/Friedhoefe/pdf/friedhoefe_gebuehren_10_2024.pdf"
  ["18-muenster-bdst-nrw-vergleich.pdf"]="https://www.sauerbier-bestattungshaus.de/sites/default/files/gebuehrensatzung_nrw_vergleich.pdf"

  # Karlsruhe
  ["19-karlsruhe-gebuehrensatzung.pdf"]="https://www.karlsruhe.de/fileadmin/user_upload/01_Stadt_Rathaus/013_Verwaltung_und_Stadtpolitik/Stadtrecht/7_OEffentliche_Einrichtungen__Wirtschaftsfoerderung/7-9_Friedhofsgebuehrensatzung.pdf"
  ["19-karlsruhe-gebuehrenverzeichnis-2025.pdf"]="https://www.friedhof-karlsruhe.de/fileadmin/user_upload/Anlage_1a_Gebuehrenverzeichnis_2025.pdf"

  # Mannheim
  ["20-mannheim-gebuehrensatzung.pdf"]="https://www.mannheim.de/sites/default/files/page/2854/s07-04.pdf"
  ["20-mannheim-aenderungssatzung.pdf"]="https://www.mannheim.de/sites/default/files/B025%20Satzung%20zur%20%C3%84nderung%20der%20Geb%C3%BChrensatzung%20im%20Bestattungswesen.pdf"
)

echo "Downloading ${#URLS[@]} files..."
for name in "${!URLS[@]}"; do
  echo "  → $name"
  curl -sS -L -o "$DIR/$name" "${URLS[$name]}" || echo "    ⚠ FAILED: $name"
done

# Include the markdown reference doc
cp funeral-pricing-sources.md "$DIR/"

zip -r friedhof-quellen.zip "$DIR"
echo ""
echo "✅ Done: friedhof-quellen.zip ($(du -h friedhof-quellen.zip | cut -f1))"
