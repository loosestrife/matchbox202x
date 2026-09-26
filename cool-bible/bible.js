const fs = require('fs');
const verses = fs.readFileSync(__dirname + '/bible','utf8').split('\n'); 
const labeledVerses = verses.map(verse=>verse.slice(1).split('] ')).filter(x=>x.length==2);

const bookNameVariants = {
  'Gen': ['Genesis', 'Gen', 'Ge', 'Gn'],
  'Ex': ['Exodus', 'Exod', 'Exo', 'Ex'],
  'Lev': ['Leviticus', 'Lev', 'Le', 'Lv'],
  'Num': ['Numbers', 'Num', 'Nu', 'Nm', 'Numb'],
  'Deut': ['Deuteronomy', 'Deut', 'De', 'Dt'],
  'Josh': ['Joshua', 'Josh', 'Jos', 'Jsh'],
  'Judg': ['Judges', 'Judg', 'Jdg', 'Jg'],
  'Ruth': ['Ruth', 'Rut', 'Ru'],
  '1Sam': ['1 Samuel', 'I Samuel', '1Sam', '1 Sam', '1Sa', '1S', 'I Sam', '1st Samuel', '1st Sam', '1Samuel'],
  '2Sam': ['2 Samuel', 'II Samuel', '2Sam', '2 Sam', '2Sa', '2S', 'II Sam', '2nd Samuel', '2nd Sam', '2Samuel'],
  '1Ki': ['1 Kings', 'I Kings', '1Ki', '1 Ki', '1Kings', '1K', 'I Ki', '1st Kings'],
  '2Ki': ['2 Kings', 'II Kings', '2Ki', '2 Ki', '2Kings', '2K', 'II Ki', '2nd Kings'],
  '1Ch': ['1 Chronicles', 'I Chronicles', '1Chr', '1 Chron', '1Ch', '1Chronicles', 'I Chron', '1st Chronicles'],
  '2Ch': ['2 Chronicles', 'II Chronicles', '2Chr', '2 Chron', '2Ch', '2Chronicles', 'II Chron', '2nd Chronicles'],
  'Ezra': ['Ezra', 'Ezr'],
  'Neh': ['Nehemiah', 'Neh', 'Ne'],
  'Esth': ['Esther', 'Esth', 'Est', 'Es'],
  'Job': ['Job', 'Jb'],
  'Ps': ['Psalms', 'Psalm', 'Ps', 'Psa', 'Psm', 'Pss'],
  'Prov': ['Proverbs', 'Prov', 'Pro', 'Prv', 'Pr'],
  'Eccl': ['Ecclesiastes', 'Eccl', 'Ecc', 'Ec', 'Qoh', 'Qoheleth'],
  'Song': ['Song of Solomon', 'Song of Songs', 'Song', 'SOS', 'So', 'Canticles', 'Canticle of Canticles'],
  'Is': ['Isaiah', 'Isa', 'Is'],
  'Jer': ['Jeremiah', 'Jer', 'Je', 'Jmr'],
  'Lam': ['Lamentations', 'Lamentation', 'Lam', 'La'],
  'Eze': ['Ezekiel', 'Ezek', 'Eze', 'Ez'],
  'Dan': ['Daniel', 'Dan', 'Da', 'Dn'],
  'Hos': ['Hosea', 'Hos', 'Ho'],
  'Joel': ['Joel', 'Joe', 'Jl'],
  'Amos': ['Amos', 'Am'],
  'Obd': ['Obadiah', 'Obad', 'Obd', 'Ob'],
  'Jon': ['Jonah', 'Jon', 'Jnh', 'Jna'],
  'Mic': ['Micah', 'Mic', 'Mc'],
  'Nah': ['Nahum', 'Nah', 'Na'],
  'Hab': ['Habakkuk', 'Hab', 'Hb'],
  'Zep': ['Zephaniah', 'Zeph', 'Zep', 'Zp'],
  'Hag': ['Haggai', 'Hag', 'Hg'],
  'Zech': ['Zechariah', 'Zech', 'Zec', 'Zc'],
  'Mal': ['Malachi', 'Mal', 'Ml'],
  'Mt': ['Matthew', 'Matt', 'Mt', 'Mat'],
  'Mk': ['Mark', 'Mk', 'Mrk', 'Mar'],
  'Lk': ['Luke', 'Lk', 'Luk'],
  'Jn': ['John', 'Jn', 'Jhn'],
  'Acts': ['Acts of the Apostles', 'Acts', 'Act'],
  'Rom': ['Romans', 'Rom', 'Ro', 'Rm'],
  '1Cor': ['1 Corinthians', 'I Corinthians', '1Cor', '1 Cor', '1Co', '1Corinthians', 'ICor', 'I Cor', '1st Corinthians'],
  '2Cor': ['2 Corinthians', 'II Corinthians', '2Cor', '2 Cor', '2Co', '2Corinthians', 'IICor', 'II Cor', '2nd Corinthians'],
  'Gal': ['Galatians', 'Gal', 'Ga'],
  'Eph': ['Ephesians', 'Eph', 'Ep'],
  'Php': ['Philippians', 'Phil', 'Phili', 'Php', 'Pp'],
  'Col': ['Colossians', 'Col', 'Co'],
  '1Th': ['1 Thessalonians', 'I Thessalonians', '1Thess', '1 Thess', '1Th', '1Thessalonians', 'IThess', 'I Thess', '1st Thessalonians'],
  '2Th': ['2 Thessalonians', 'II Thessalonians', '2Thess', '2 Thess', '2Th', '2Thessalonians', 'IIThess', 'II Thess', '2nd Thessalonians'],
  '1Ti': ['1 Timothy', 'I Timothy', '1Tim', '1 Tim', '1Ti', '1Timothy', 'I Tim', '1st Timothy'],
  '2Ti': ['2 Timothy', 'II Timothy', '2Tim', '2 Tim', '2Ti', '2Timothy', 'II Tim', '2nd Timothy'],
  'Tit': ['Titus', 'Tit', 'Ti'],
  'Phe': ['Philemon', 'Phm', 'Phe', 'Philem', 'Pm'],
  'Heb': ['Hebrews', 'Heb', 'He'],
  'Jam': ['James', 'Jas', 'Jam', 'Jm'],
  '1Pe': ['1 Peter', 'I Peter', '1Pet', '1 Pet', '1Pe', '1Pt', '1Peter', 'I Pet', '1st Peter'],
  '2Pe': ['2 Peter', 'II Peter', '2Pet', '2 Pet', '2Pe', '2Pt', '2Peter', 'II Pet', '2nd Peter'],
  '1Jn': ['1 John', 'I John', '1John', '1 Jn', '1Jn', 'I Jn', '1st John'],
  '2Jn': ['2 John', 'II John', '2John', '2 Jn', '2Jn', 'II Jn', '2nd John'],
  '3Jn': ['3 John', 'III John', '3John', '3 Jn', '3Jn', 'III Jn', '3rd John'],
  'Jude': ['Jude', 'Jud', 'Jd'],
  'Rev': ['Revelation', 'Revelation of John', 'Revelations', 'Rev', 'Apocalypse', 'Apoc']
};

const bookRef2short = {};
const shortRef2long = {};
Object.keys(bookNameVariants).forEach(sref => {
  bookRef2short[sref] = sref;
  bookNameVariants[sref].forEach(ref=>bookRef2short[ref]=sref);
  shortRef2long[sref] = bookNameVariants[sref][0] ?? sref;
});
const bookRef2shortFn = (ref) => {
  if(typeof ref != 'string'){
    throw new Error(`non string ${ref} in bookRef2shortFn`);
  }
  if(bookRef2short[ref]){
    return bookRef2short[ref];
  }
  const noDotSpace = ref.replace(/[. ]/g,'');
  if(bookRef2short[noDotSpace]){
    return bookRef2short[noDotSpace];
  }
  throw new Error(`cant find Bible book for ${ref}/${noDotSpace}`);
}

const bibleData = {};
labeledVerses.forEach(([label, verseText])=>{
  const labelParts = label.split(' ');
  const chapterVerse = labelParts.pop();
  const longBook = labelParts.join(' ');
  const book = bookRef2short[longBook];
  const [chapter, verseId] = chapterVerse.split(':');
  if(!bibleData[book]){
    bibleData[book] = {};
  }
  if(!bibleData[book][chapter]){
    bibleData[book][chapter] = {};
  }
  bibleData[book][chapter][verseId] = verseText;
});


const paraStarts = labeledVerses.filter(
  ([label, verseText])=>verseText[0]=='¶'
).map(
  ([label, verseText])=>label
);
const paraBooks = {};
for(const ps of paraStarts){
  const parts = ps.split(' ');
  parts.pop();
  const book = parts.join(' ');
  if(paraBooks[book]){
    paraBooks[book]++;
  } else {
    paraBooks[book] = 1;
  }
}
const startsPara = text => text[0] == '¶';
const paraGen = (book)=>{
  const allParas = [];
  let paraBuf = [];
  const appendPara = () => {
    allParas.push(paraBuf.join(' '));
    paraBuf = [];
  };
  const addVerse = (label, verseText) => {
    paraBuf.push(label.split(':')[1]+verseText);
  };
  for(let i=0; i<labeledVerses.length; i++){
    const [label, verseText] = labeledVerse[i];
    if(label.startsWith(book)){
      if(startsPara(verseText)){
        appendPara();
      }
      addVerse(label, verseText);
      if(i==labeledVerse.length-1){
        appendPara();
      }
    }
  }
  return allParas;
};
const randomVerse = () => verses[Math.floor(Math.random() * verses.length)];
const getBibleVerse = (book, chapter, verse) => {
  return bibleData[book][chapter][verse];
}
function getBibleSection(book, chapter, startVerse = undefined, endVerse = undefined) {
  const chapterVerses = bibleData[book]?.[chapter];
  if (!chapterVerses) return [];

  // If verse numbers are undefined, return the entire chapter
  if (startVerse == undefined) {
    return chapterVerses;
  }

  const finalVerse = endVerse ?? startVerse;
  return chapterVerses.filter(v => v.verse >= startVerse && v.verse <= finalVerse);
}

// Map or Set of single-chapter books (including common abbreviations)
const SINGLE_CHAPTER_BOOKS = new Set([
  "Obd",
  "Phm",
  "2Jn",
  "3Jn",
  "Jude",
]);

function lookupReference(refString) {
  const { book, chapter, startVerse, endVerse } = parseReferenceString(refString);
  return getBibleSection(book, chapter, startVerse, endVerse);
}

function parseReferenceString(refString) {
  console.log["bible.js: looking up ref", refString];
  const trimmed = refString.trim();

  // Match the book string (anything) followed by trailing digits/ranges at the end
  const match = trimmed.match(/^(.*?)\s+([\d:a-bA-B\-]+)$/);

  let rawBook = trimmed;
  let refPart = null;

  if (match) {
    rawBook = match[1].trim();
    refPart = match[2];
  }

  bookRef = bookRef2shortFn(rawBook);
  // Standardize book lookup check
  const isSingleChapter = SINGLE_CHAPTER_BOOKS.has(bookRef);

  // Case 1: No trailing reference numbers (e.g., "John" or "Jude")
  if (!refPart) {
    return {
      book: rawBook,
      chapter: isSingleChapter ? 1 : undefined,
      startVerse: undefined,
      endVerse: undefined
    };
  }

  // Strip 'a', 'b', or other verse letter suffixes (e.g., "8:1a-5b" -> "8:1-5")
  const cleanedRef = refPart.replace(/[a-zA-Z]/g, '');

  let chapter, startVerse, endVerse;

  if (cleanedRef.includes(':')) {
    // Standard format with colon: "8:1", "8:1-12", or "1:5"
    const [chapStr, verseStr] = cleanedRef.split(':');
    chapter = parseInt(chapStr, 10);

    if (verseStr.includes('-')) {
      const [v1, v2] = verseStr.split('-');
      startVerse = parseInt(v1, 10);
      endVerse = parseInt(v2, 10);
    } else {
      startVerse = parseInt(verseStr, 10);
      endVerse = startVerse;
    }
  } else {
    // No colon: e.g., "8", "5", or "5-10"
    if (isSingleChapter) {
      chapter = 1;
      if (cleanedRef.includes('-')) {
        const [v1, v2] = cleanedRef.split('-');
        startVerse = parseInt(v1, 10);
        endVerse = parseInt(v2, 10);
      } else {
        startVerse = parseInt(cleanedRef, 10);
        endVerse = startVerse;
      }
    } else {
      // Standard multi-chapter book without verses (e.g., "John 8")
      chapter = parseInt(cleanedRef, 10);
      startVerse = undefined;
      endVerse = undefined;
    }
  }

  return { book: rawBook, chapter, startVerse, endVerse };
}

module.exports = {labeledVerses, bibleData,
  randomVerse, getBibleVerse, getBibleSection, lookupReference,
  bookRef2short, shortRef2long,
  paraGen, paraBooks, paraStarts, bookRef2shortFn};
