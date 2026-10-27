"""Inter and IBM Plex Mono with Cyrillic, from Google Fonts (OFL), into the video project's assets/fonts/.
Keeps only the cyrillic and latin subsets; prints the @font-face rules for frame.md."""
import re
import sys
import urllib.request
from pathlib import Path

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
FAMILIES = {
    "Inter": "https://fonts.googleapis.com/css2?family=Inter:wght@400..900&display=block",
    "IBM Plex Mono": "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&display=block",
}
rules = []
for family, url in FAMILIES.items():
    css = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode()
    for subset, block in re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*{[^}]*})", css):
        if subset not in ("cyrillic", "latin"):
            continue
        src = re.search(r"url\((https://[^)]+\.woff2)\)", block).group(1)
        weight = re.search(r"font-weight:\s*([\d ]+);", block).group(1).strip()
        urange = re.search(r"unicode-range:\s*([^;]+);", block).group(1).strip()
        name = f"{family.replace(' ', '')}-{weight.replace(' ', '_')}-{subset}.woff2"
        data = urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=30).read()
        (out / name).write_bytes(data)
        rules.append(f'@font-face{{font-family:"{family}";font-weight:{weight};font-style:normal;font-display:block;'
                     f'src:url("assets/fonts/{name}") format("woff2");unicode-range:{urange};}}')
        print(f"{name}: {len(data) // 1024} KB")
(out / "fonts.css").write_text("\n".join(rules) + "\n", encoding="utf-8")
print("rules:", len(rules))
