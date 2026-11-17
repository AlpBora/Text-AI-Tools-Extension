# Bundled Lexicon Sources & Licenses

All lexicons in `shared/lexicons/` are compiled by `scripts/build_lexicons.mjs` exclusively from permissive open-source datasets:

## 1. hermitdave/FrequencyWords (2018 OpenSubtitles)
- **Files used**: `en_50k.txt`, `tr_50k.txt`
- **Repository**: https://github.com/hermitdave/FrequencyWords
- **License**: MIT License (Copyright (c) 2016 Hermit Dave)
- **Usage**: Frequency weights (`Math.round(Math.log10(count + 1) * 100)`) for English and Turkish surface words.

## 2. wooorm/dictionaries (SCOWL en & Turkish Hunspell)
- **Files used**: `dictionaries/en/index.dic`, `dictionaries/en/index.aff`, `dictionaries/tr/index.dic`, `dictionaries/tr/index.aff`
- **Repository**: https://github.com/wooorm/dictionaries
- **Licenses**:
  - `dictionaries/en`: SCOWL / MIT-style permissive license (http://wordlist.sourceforge.net)
  - `dictionaries/tr`: MIT License (Copyright (c) 2014 Harun Reşit Zafer)
- **Usage**: Validation/filtering of OpenSubtitles corpus entries to eliminate subtitle typos and non-target-language artifacts.

## 3. ahmetaa/zemberek-nlp (Turkish Morphological Lexicon)
- **Files used**: `morphology/src/main/resources/tr/master-dictionary.dict`, `proper.dict`
- **Repository**: https://github.com/ahmetaa/zemberek-nlp
- **License**: Apache License 2.0 (Copyright 2018 Ahmet A. Akın, Mehmet D. Akın)
- **Usage**: Turkish root lemmas, POS tags (`Noun`, `Verb`, `Adj`, `Adv`, `Proper`, `Num`, `Other`), and morphophonological irregularity flags (`Voicing`, `NoVoicing`, `LastVowelDrop`, `InverseHarmony`, `Doubling`, `Aorist_A`, `Aorist_I`, etc.).
