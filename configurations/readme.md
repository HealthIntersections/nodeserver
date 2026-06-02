This folder contains some basic starter configurations:

* Terminology server: see tx-config.json for a vanilla server that doesn't contain any licensed content
* NPM web server: see projector.json for a basic configuration to make a package available online

To use these, copy the relevant file to your local data directory, and rename to config.json

---

## Configuration ANS (ans.fr.terminologies)

Les fichiers `ans-config.json` et `ans-library.yaml` fournissent une configuration prête à l'emploi
pour déployer un serveur de terminologie FHIR avec les ressources françaises de l'ANS.

### Qu'est-ce que le package enrichi ?

Le package `ans.fr.terminologies` publié par l'ANS contient les ValueSets et CodeSystems du référentiel français.
Cependant, la plupart des CodeSystems y sont déclarés sans contenu (`"content": "not-present"`).

Le **package enrichi** (`ans.fr.terminologies-enriched`) est une version augmentée de ce package dans laquelle
le contenu complet de chaque CodeSystem a été téléchargé depuis le SMT (Système de Management des Terminologies
d'eSanté, `https://smt.esante.gouv.fr/fhir`). Cela permet au serveur de terminologie de répondre aux
opérations `$expand` et `$lookup` sur l'ensemble des codes ANS.

### Ce qui est inclus

- **`ans.fr.terminologies-enriched#1.9.1`** — package ANS enrichi avec le contenu complet des CodeSystems depuis le SMT
- **SNOMED CT édition française** — terminologie clinique en français
- **LOINC** — avec les libellés français de référence
- **HL7 terminology, IPS, IHE format codes** — terminologies internationales complémentaires

Les paramètres `internalLimit` et `externalLimit` sont fixés à 1 000 000 pour permettre l'expansion
des grands ValueSets ANS (certains contiennent plus de 3 000 codes).

### Téléchargement automatique

Les fichiers terminologiques volumineux (SNOMED CT, LOINC, package ANS enrichi) sont hébergés sur le
serveur ANS à l'adresse `http://interop.esante.gouv.fr/tx/data`. FHIRsmith les télécharge
automatiquement au démarrage s'ils ne sont pas déjà présents dans le cache local.

**Aucune action manuelle n'est nécessaire** pour récupérer ces fichiers.

### Installation

```bash
# Cloner le dépôt et installer les dépendances
git clone https://github.com/ansforge/interop-outil-fhir-terminology-server
cd interop-outil-fhir-terminology-server
npm install

# Créer le répertoire de données
mkdir -p data

# Remplacer la configuration par défaut par la configuration ANS
cp configurations/ans-config.json data/config.json
cp configurations/ans-library.yaml data/library.yaml

# Démarrer le serveur — les fichiers terminologiques sont téléchargés automatiquement au premier lancement
npm run dev
```

Le serveur de terminologie est accessible à l'adresse `http://localhost:3000/tx/r4`.

### Génération manuelle des fichiers (optionnel)

Si vous souhaitez générer les fichiers terminologiques vous-même plutôt que de les télécharger :

1. **Générer le package ANS enrichi** — télécharge le contenu des CodeSystems depuis le SMT :
   ```bash
   node tx/importers/enrich-ans-package.js
   ```
   Puis créer l'archive `.tgz` à héberger sur votre serveur :
   ```bash
   cd data/terminology-cache
   tar -czf ans.fr.terminologies-1.9.1-enriched.tgz "ans.fr.terminologies#1.9.1-enriched/"
   ```

2. **Importer LOINC** — nécessite une licence LOINC et les fichiers sources depuis [loinc.org](https://loinc.org) :
   ```bash
   node --max-old-space-size=8192 tx/importers/tx-import.js loinc import \
     --source ./tx/data/Loinc_2.82 \
     --dest ./data/terminology-cache/loinc.db \
     --yes
   ```

3. **Importer SNOMED CT édition française** — nécessite une licence SNOMED CT :
   ```bash
   node --max-old-space-size=8192 tx/importers/tx-import.js snomed import \
     --source ./tx/data/SnomedCT_ManagedServiceFrance \
     --dest ./data/terminology-cache/snomed-fr.cache \
     --yes
   ```
