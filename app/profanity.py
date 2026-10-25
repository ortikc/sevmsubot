"""A basic swearing filter for posts everyone can read (the shared feed and visitors of a club).

It looks for the roots of Russian мат word by word, after undoing the simplest disguises:
Latin letters that look Cyrillic (xyй), digits for letters (е6ать), dots and dashes inside a word (х.у.й)
and stretched letters (хууууй). The patterns are anchored where a plain substring would also catch
ordinary words: себе, небо, корабля, сабля, страхуем, бляха, мудрый."""
import re

# Latin and digit look-alikes of Cyrillic letters
LOOKALIKE = str.maketrans({
    "a": "а", "b": "в", "c": "с", "e": "е", "h": "н", "k": "к", "m": "м", "o": "о", "p": "р",
    "t": "т", "u": "и", "x": "х", "y": "у", "0": "о", "3": "з", "6": "б", "@": "а", "ё": "е",
})
INSIDE_WORD = re.compile(r"(?<=\w)[.\-_*'`’]+(?=\w)")   # х.у.й, х-у-й
STRETCHED = re.compile(r"(\w)\1+")                       # хууууй
WORD = re.compile(r"[а-яa-z0-9@]+")

ROOTS = re.compile("|".join([
    r"^(?:на|по|о|а|ни|до|за|от|при|ох|пох|рас|вы)?ху[йяюеи]",                      # хуй, нахуй, охуеть
    r"п[ие]зд",                                                                      # пизда, спиздить
    r"^(?:за|вы|на|у|от|отъ|съ|до|про|по|пере|раз|разъ|из|изъ|въ|подъ|объ|при|долбо|долба|недо)?еб",  # ебать, заебал
    r"^бля(?!х)",                                                                    # блядь, but not бляха
    r"^муд[аои]",                                                                    # мудак, but not мудрый
    r"г[ао]ндон",
    r"пид[оа]р|^пидр",
    r"залуп",
    r"шлюх",
]))


def has_profanity(text: str) -> bool:
    plain = INSIDE_WORD.sub("", (text or "").lower()).translate(LOOKALIKE)
    return any(ROOTS.search(STRETCHED.sub(r"\1", w)) for w in WORD.findall(plain))
