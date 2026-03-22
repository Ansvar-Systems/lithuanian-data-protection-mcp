/**
 * Seed the VDAI database with sample decisions and guidelines for testing.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["VDAI_DB_PATH"] ?? "data/vdai.db";
const force = process.argv.includes("--force");

// --- Bootstrap database ------------------------------------------------------

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Deleted existing database at ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database initialised at ${DB_PATH}`);

// --- Topics ------------------------------------------------------------------

interface TopicRow {
  id: string;
  name_local: string;
  name_en: string;
  description: string;
}

const topics: TopicRow[] = [
  {
    id: "cookies",
    name_local: "Slapukai ir sekikliai",
    name_en: "Cookies and trackers",
    description: "Slapukų ir kitų sekiklių naudojimas galutinių vartotojų įrenginiuose (BDAR 6 str.).",
  },
  {
    id: "employee_monitoring",
    name_local: "Darbuotojų stebėjimas",
    name_en: "Employee monitoring",
    description: "Darbuotojų duomenų tvarkymas ir stebėjimas darbo vietoje.",
  },
  {
    id: "video_surveillance",
    name_local: "Vaizdo stebėjimas",
    name_en: "Video surveillance",
    description: "Vaizdo stebėjimo sistemų naudojimas ir asmens duomenų apsauga (BDAR 6 str.).",
  },
  {
    id: "data_breach",
    name_local: "Duomenų saugumo pažeidimai",
    name_en: "Data breach notification",
    description: "Pranešimas apie asmens duomenų saugumo pažeidimus VDAI ir duomenų subjektams (BDAR 33–34 str.).",
  },
  {
    id: "consent",
    name_local: "Sutikimas",
    name_en: "Consent",
    description: "Sutikimo su asmens duomenų tvarkymu gavimas, galiojimas ir atšaukimas (BDAR 7 str.).",
  },
  {
    id: "dpia",
    name_local: "Poveikio duomenų apsaugai vertinimas",
    name_en: "Data Protection Impact Assessment (DPIA)",
    description: "Poveikio duomenų apsaugai vertinimas aukštos rizikos tvarkymui (BDAR 35 str.).",
  },
  {
    id: "transfers",
    name_local: "Tarptautiniai duomenų perdavimai",
    name_en: "International data transfers",
    description: "Asmens duomenų perdavimas į trečiąsias šalis arba tarptautines organizacijas (BDAR 44–49 str.).",
  },
  {
    id: "data_subject_rights",
    name_local: "Duomenų subjektų teisės",
    name_en: "Data subject rights",
    description: "Prieigos, ištaisymo, ištrynimo ir kitų teisių įgyvendinimas (BDAR 15–22 str.).",
  },
];

const insertTopic = db.prepare(
  "INSERT OR IGNORE INTO topics (id, name_local, name_en, description) VALUES (?, ?, ?, ?)",
);

for (const t of topics) {
  insertTopic.run(t.id, t.name_local, t.name_en, t.description);
}

console.log(`Inserted ${topics.length} topics`);

// --- Decisions ---------------------------------------------------------------

interface DecisionRow {
  reference: string;
  title: string;
  date: string;
  type: string;
  entity_name: string;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

const decisions: DecisionRow[] = [
  {
    reference: "2N-110-(3.9.)-2022",
    title: "VDAI sprendimas dėl slapukų naudojimo pažeidimų",
    date: "2022-06-15",
    type: "sanction",
    entity_name: "Elektroninės prekybos bendrovė",
    fine_amount: 15000,
    summary:
      "VDAI skyrė 15 000 EUR baudą elektroninės prekybos bendrovei už slapukų naudojimą be išankstinio vartotojų sutikimo ir nesuteikimą galimybės atsisakyti nesvarbiausių slapukų taip pat lengvai, kaip juos priimti.",
    full_text:
      "Valstybinė duomenų apsaugos inspekcija atliko patikrinimą ir nustatė, kad elektroninės prekybos bendrovė naudojo reklaminius ir analitinės paskirties slapukus vartotojų įrenginiuose be jų išankstinio sutikimo. Vartotojai buvo informuojami apie slapukų naudojimą tik po to, kai slapukai jau buvo įdiegti. Be to, bendrovė nesuteikė vartotojams lygiaverčio būdo atsisakyti slapukų kaip juos priimti — atsisakymo mygtukas buvo pasleistas keliuose submeniu lygiuose. VDAI nustatė šiuos pažeidimus: 1) reklaminiai slapukai įdiegiami be sutikimo nuo pat apsilankymo pradžios; 2) atsisakymo mechanizmas yra ženkliai sudėtingesnis nei priėmimo; 3) informacija apie slapukų tikslus nepakankama. Bendrovei skirta 15 000 EUR bauda ir įpareigota per 60 dienų pašalinti pažeidimus.",
    topics: JSON.stringify(["cookies", "consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
  {
    reference: "2N-88-(3.9.)-2022",
    title: "VDAI sprendimas dėl darbuotojų stebėjimo",
    date: "2022-03-22",
    type: "sanction",
    entity_name: "Logistikos įmonė",
    fine_amount: 25000,
    summary:
      "VDAI skyrė 25 000 EUR baudą logistikos įmonei už neproporcingą darbuotojų stebėjimą naudojant GPS sekimą ne tik darbo metu, bet ir poilsio laikotarpiu, taip pažeidžiant proporcingumo principą.",
    full_text:
      "VDAI gavo skundą iš darbuotojų dėl nuolatinio GPS sekimo naudojant transporto priemonių stebėjimo sistemą. Tyrimo metu nustatyta: 1) GPS sekimas vyko 24/7, įskaitant darbo ne valandas ir savaitgalius, nors teisėta priežastis egzistavo tik darbo metu; 2) darbuotojai nebuvo tinkamai informuoti apie duomenų tvarkymo apimtį ir tikslus prieš pradedant diegti sistemą; 3) duomenys saugomi 2 metus, nors pagrįstas laikotarpis — 3 mėnesiai. VDAI nurodė, kad darbdaviai gali taikyti GPS stebėjimą tik darbo metu ir tik esant teisėtam tikslui. Bendrovei skirta 25 000 EUR bauda ir įpareigota apriboti sekimą darbo valandomis.",
    topics: JSON.stringify(["employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "2N-45-(3.9.)-2023",
    title: "VDAI sprendimas dėl vaizdo stebėjimo darbo vietoje",
    date: "2023-02-10",
    type: "warning",
    entity_name: "Mažmeninės prekybos tinklas",
    fine_amount: null,
    summary:
      "VDAI išreiškė įspėjimą mažmeninės prekybos tinklui dėl vaizdo stebėjimo kamerų naudojimo darbuotojų poilsio zonose ir nesuteikimo tinkamos informacijos apie vaizdo stebėjimą.",
    full_text:
      "VDAI atliko planinius patikrinimus mažmeninės prekybos tinklo parduotuvėse ir nustatė, kad vaizdo stebėjimo kameros buvo įrengtos darbuotojų poilsio zonose — persirengimo kambariuose ir kambariuose. Tai yra akivaizdus proporcingumo principo pažeidimas, nes nėra teisėto pagrindo tokio intensyvaus stebėjimo privačiose darbuotojų zonose. Be to, darbuotojai nebuvo tinkamai informuoti apie kamerų buvimą ir apdorojamų duomenų apimtį. VDAI išreiškė įspėjimą ir įpareigojo: 1) nedelsiant pašalinti kameras iš darbuotojų poilsio zonų; 2) peržiūrėti vaizdo stebėjimo politiką ir suderinti ją su BDAR reikalavimais; 3) parengti ir paskelbti aiškią informaciją darbuotojams apie vaizdo stebėjimą.",
    topics: JSON.stringify(["video_surveillance", "employee_monitoring"]),
    gdpr_articles: JSON.stringify(["5", "6", "13"]),
    status: "final",
  },
  {
    reference: "2N-201-(3.9.)-2023",
    title: "VDAI sprendimas dėl asmens duomenų saugumo pažeidimo pranešimo",
    date: "2023-09-05",
    type: "sanction",
    entity_name: "Telekomunikacijų paslaugų teikėjas",
    fine_amount: 50000,
    summary:
      "VDAI skyrė 50 000 EUR baudą telekomunikacijų bendrovei už pavėluotą ir nepilną pranešimą apie duomenų saugumo pažeidimą, per kurį buvo atskleisti 85 000 klientų asmens duomenys.",
    full_text:
      "Telekomunikacijų paslaugų teikėjas patyrė duomenų saugumo pažeidimą, per kurį buvo atskleisti 85 000 klientų asmens duomenys, įskaitant vardus, adresus, telefono numerius ir dalį mokėjimo informacijos. VDAI nustatė šiuos pažeidimus: 1) pranešimas VDAI pateiktas tik po 8 dienų nuo incidento aptikimo, nors teisinis terminas — 72 valandos; 2) pranešime nebuvo pateikta visa reikalaujama informacija — duomenų kategorijos, apytikris paveiktų asmenų skaičius ir rizikos įvertinimas; 3) paveikti asmenys nebuvo informuoti, nors incidentas kėlė didelę riziką jų teisėms ir laisvėms. Bendrovei skirta 50 000 EUR bauda. VDAI pabrėžė, kad 72 valandų terminas yra imperatyvus ir jo praleidimas yra rimtas pažeidimas.",
    topics: JSON.stringify(["data_breach"]),
    gdpr_articles: JSON.stringify(["33", "34"]),
    status: "final",
  },
  {
    reference: "2N-156-(3.9.)-2023",
    title: "VDAI sprendimas dėl tiesioginės rinkodaros be sutikimo",
    date: "2023-07-18",
    type: "sanction",
    entity_name: "Finansinių paslaugų bendrovė",
    fine_amount: 30000,
    summary:
      "VDAI skyrė 30 000 EUR baudą finansinių paslaugų bendrovei už tiesioginės rinkodaros elektroninių laiškų siuntimą klientams be tinkamo sutikimo ir nesuteikimą lengvo atsisakymo mechanizmo.",
    full_text:
      "VDAI ištyrė skundus iš vartotojų, kurie gavo nepageidaujamus rinkodaros laiškus iš finansinių paslaugų bendrovės. Tyrimas atskleidė: 1) bendrovė siuntė rinkodaros pranešimus asmenims, kurie nesuteikė aiškaus ir nedviprasmiško sutikimo gauti tokius pranešimus — sutikimas buvo gautas per iš anksto pažymėtus langelius; 2) atsisakymo nuo prenumeratos mygtukas buvo paslėptas el. laiško apačioje mažu šriftu; 3) kai kurie asmenys pranešė, kad po atsisakymo pranešimai vis tiek buvo gaunami kelias savaites. Sutikimo gavimas per iš anksto pažymėtus langelius neatitinka BDAR 7 straipsnio reikalavimų dėl aktyvaus veiksmo. Bendrovei skirta 30 000 EUR bauda.",
    topics: JSON.stringify(["consent"]),
    gdpr_articles: JSON.stringify(["6", "7"]),
    status: "final",
  },
];

const insertDecision = db.prepare(`
  INSERT OR IGNORE INTO decisions
    (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertDecisionsAll = db.transaction(() => {
  for (const d of decisions) {
    insertDecision.run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
  }
});

insertDecisionsAll();
console.log(`Inserted ${decisions.length} decisions`);

// --- Guidelines --------------------------------------------------------------

interface GuidelineRow {
  reference: string | null;
  title: string;
  date: string;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

const guidelines: GuidelineRow[] = [
  {
    reference: "VDAI-VADOVAS-SLAPUKAI-2022",
    title: "Slapukų naudojimo gairės",
    date: "2022-04-01",
    type: "guide",
    summary:
      "VDAI gairės dėl slapukų ir kitų sekiklių naudojimo. Apima sutikimo gavimo reikalavimus, informacijos teikimą vartotojams ir atsisakymo mechanizmų įdiegimą.",
    full_text:
      "Šiose gairėse VDAI paaiškina reikalavimus slapukų naudojimui Lietuvoje pagal BDAR ir Elektroninių ryšių įstatymą. Pagrindiniai reikalavimai: 1) Sutikimas prieš slapukus — nesvarbiesiems slapukams (reklaminiai, analitiniai) reikalingas išankstinis, aiškus ir aktyvus vartotojo sutikimas; tik techniniai slapukai, būtini svetainei veikti, gali būti naudojami be sutikimo; 2) Priimti ir atsisakyti — turi būti suteikta galimybė vienodai lengvai tiek priimti, tiek atsisakyti slapukų; nepriimtini slapukų užtvankos (cookie walls), išskyrus pagrįstus atvejus; 3) Informacija — aiški informacija apie slapukų tikslus, trukmę ir trečiąsias šalis; 4) Atšaukimas — vartotojai turi galėti bet kada atšaukti savo sutikimą; 5) Įrodymas — sutikimas turi būti įrodomas, rekomenduojama saugoti sutikimų žurnalą. Gairės taikomos visoms Lietuvoje veikiančioms organizacijoms, naudojančioms slapukus.",
    topics: JSON.stringify(["cookies", "consent"]),
    language: "lt",
  },
  {
    reference: "VDAI-VADOVAS-POVEIKIO-VERTINIMAS-2021",
    title: "Poveikio duomenų apsaugai vertinimo atlikimo gairės",
    date: "2021-11-15",
    type: "guide",
    summary:
      "VDAI metodinės gairės dėl poveikio duomenų apsaugai vertinimo (PDAV). Apima, kada PDAV privalomas, kaip jį atlikti ir kaip dokumentuoti.",
    full_text:
      "BDAR 35 straipsnis reikalauja atlikti poveikio duomenų apsaugai vertinimą (PDAV), kai tvarkymas gali sukelti didelę riziką fizinių asmenų teisėms ir laisvėms. PDAV privalomas visų pirma: tvarkant biometrinius ar sveikatos duomenis dideliu mastu; sistemingai stebint viešas vietas; tvarkant duomenis automatizuotų sprendimų tikslais, turinčiais teisinių pasekmių. PDAV etapai: 1) Tvarkymo aprašymas — duomenų kategorijos, tikslai, gavėjai, perdavimas, saugojimo terminas; 2) Būtinumo ir proporcingumo vertinimas — ar tvarkymas teisėtas, ar duomenys minimalūs, ar duomenų subjektų teisės gali būti įgyvendintos; 3) Rizikos valdymas — galimų grėsmių (neteisėta prieiga, praradimas, pakeitimas) nustatymas, tikimybės ir rimtumo vertinimas, papildomų priemonių apibrėžimas. VDAI rekomenduoja naudoti Europos duomenų apsaugos valdybos (EDAV) metodologiją ir įrankius.",
    topics: JSON.stringify(["dpia"]),
    language: "lt",
  },
  {
    reference: "VDAI-GAIRES-DUOMENU-SUBJEKTAI-2022",
    title: "Duomenų subjektų teisių įgyvendinimo gairės",
    date: "2022-08-30",
    type: "guide",
    summary:
      "VDAI gairės dėl duomenų subjektų teisių — prieigos, ištaisymo, ištrynimo, apribojimo, perkėlimo ir prieštaravimo — įgyvendinimo. Apima terminus, procedūras ir išimtis.",
    full_text:
      "BDAR suteikia duomenų subjektams plačias teises dėl jų asmens duomenų tvarkymo. Pagrindinės teisės: 1) Teisė susipažinti (15 str.) — asmuo turi teisę gauti patvirtinimą, ar tvarkomi jo duomenys, ir jų kopiją; atsakymas turi būti pateiktas per 1 mėnesį; 2) Teisė reikalauti ištaisymo (16 str.) — netikslius duomenis privaloma ištaisyti be nepagrįsto delsimo; 3) Teisė reikalauti ištrinti (17 str.) — 'teisė būti pamirštam' tam tikromis aplinkybėmis, pvz., sutikimo atšaukimas, teisėto pagrindo nebuvimas; 4) Teisė apriboti tvarkymą (18 str.) — asmuo gali reikalauti apriboti duomenų tvarkymą ginčijant tikslumą arba prieštaraujant tvarkymui; 5) Teisė į duomenų perkeliamumą (20 str.) — asmuo turi teisę gauti savo duomenis struktūrizuotu, įprastai naudojamu ir kompiuterio skaitomu formatu; 6) Teisė nesutikti (21 str.) — asmuo gali nesutikti su tvarkymu teisėtų interesų ar tiesioginės rinkodaros tikslais. Organizacijos privalo turėti aiškias procedūras šioms teisėms įgyvendinti ir atsakyti per nustatytus terminus.",
    topics: JSON.stringify(["data_subject_rights"]),
    language: "lt",
  },
];

const insertGuideline = db.prepare(`
  INSERT INTO guidelines (reference, title, date, type, summary, full_text, topics, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertGuidelinesAll = db.transaction(() => {
  for (const g of guidelines) {
    insertGuideline.run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
  }
});

insertGuidelinesAll();
console.log(`Inserted ${guidelines.length} guidelines`);

// --- Summary -----------------------------------------------------------------

const decisionCount = (
  db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }
).cnt;
const guidelineCount = (
  db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }
).cnt;
const topicCount = (
  db.prepare("SELECT count(*) as cnt FROM topics").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Topics:     ${topicCount}`);
console.log(`  Decisions:  ${decisionCount}`);
console.log(`  Guidelines: ${guidelineCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
