#!/usr/bin/env python3
"""Génère web/geo-data.js à partir de la base ISO 3166 du système.

Les localisations GitHub sont du texte libre ; ce fichier fournit au navigateur
les tables nécessaires pour les rattacher à un pays puis à un continent.
Régénération :  python3 tools/gen_geo.py
"""
import gettext
import json
import unicodedata
from pathlib import Path

ISO_JSON = Path("/usr/share/iso-codes/json/iso_3166-1.json")
OUT = Path(__file__).resolve().parent.parent / "web" / "geo-data.js"

CONTINENTS = {
    "EU": "AL AD AT AX BY BE BA BG CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE "
          "LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM UA VA",
    "AS": "AE AF AM AZ BD BH BN BT CC CN CX GE HK ID IL IN IO IQ IR JO JP KG KH KP KR KW KZ LA LB "
          "LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TJ TL TM TR TW UZ VN YE",
    "AF": "AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW KE KM LR LS LY MA "
          "MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TG TN TZ UG YT ZA ZM ZW",
    "NA": "AG AI AW BB BL BM BQ BS BZ CA CR CU CW DM DO GD GL GP GT HN HT JM KN KY LC MF MQ MS MX "
          "NI PA PM PR SV SX TC TT US VC VG VI",
    "SA": "AR BO BR CL CO EC FK GF GY PE PY SR UY VE",
    "OC": "AS AU CK FJ FM GU KI MH MP NC NF NR NU NZ PF PG PN PW SB TK TO TV UM VU WF WS",
    "AN": "AQ BV GS HM TF",
}
CONTINENT_NAMES = {
    "EU": "Europe", "AS": "Asie", "AF": "Afrique", "NA": "Amérique du Nord",
    "SA": "Amérique du Sud", "OC": "Océanie", "AN": "Antarctique", "XX": "Non déterminé",
}

# Alias fréquents que la base ISO ne couvre pas (usages courants, langues locales).
EXTRA_ALIASES = {
    "usa": "US", "u s a": "US", "us": "US", "america": "US", "united states of america": "US",
    "etats unis": "US", "amerique": "US", "murica": "US",
    "uk": "GB", "u k": "GB", "england": "GB", "angleterre": "GB", "scotland": "GB", "wales": "GB",
    "great britain": "GB", "britain": "GB", "grande bretagne": "GB", "royaume uni": "GB",
    "northern ireland": "GB", "ecosse": "GB",
    "uae": "AE", "emirates": "AE", "emirats": "AE",
    "deutschland": "DE", "allemagne": "DE", "germany": "DE",
    "espana": "ES", "espagne": "ES", "spain": "ES", "catalunya": "ES", "catalonia": "ES",
    "italia": "IT", "italie": "IT", "brasil": "BR", "bresil": "BR",
    "holland": "NL", "the netherlands": "NL", "pays bas": "NL", "nederland": "NL",
    "suisse": "CH", "schweiz": "CH", "svizzera": "CH", "belgique": "BE", "belgie": "BE",
    "osterreich": "AT", "autriche": "AT", "sverige": "SE", "suede": "SE", "norge": "NO",
    "danmark": "DK", "suomi": "FI", "polska": "PL", "pologne": "PL", "cesko": "CZ",
    "tchequie": "CZ", "czechia": "CZ", "czech republic": "CZ", "magyarorszag": "HU",
    "ellada": "GR", "grece": "GR", "portugal": "PT", "turkiye": "TR", "turquie": "TR",
    "rossiya" : "RU", "russie": "RU", "russian federation": "RU",
    "ukraina": "UA", "belarus": "BY", "moldova": "MD",
    "prc": "CN", "china": "CN", "chine": "CN", "mainland china": "CN", "zhongguo": "CN",
    "hong kong sar": "HK", "macau": "MO", "taiwan": "TW", "roc": "TW",
    "nippon": "JP", "japon": "JP", "japan": "JP", "nihon": "JP",
    "south korea": "KR", "coree du sud": "KR", "korea": "KR", "republic of korea": "KR",
    "north korea": "KP", "inde": "IN", "bharat": "IN", "bhārat": "IN",
    "viet nam": "VN", "vietnam": "VN", "thailande": "TH", "philippines": "PH",
    "indonesie": "ID", "malaisie": "MY", "singapour": "SG", "pakistan": "PK",
    "bangladesh": "BD", "sri lanka": "LK", "nepal": "NP", "iran": "IR", "irak": "IQ",
    "arabie saoudite": "SA", "ksa": "SA", "saudi": "SA", "israel": "IL", "palestine": "PS",
    "egypte": "EG", "maroc": "MA", "morocco": "MA", "algerie": "DZ", "tunisie": "TN",
    "cote d ivoire": "CI", "ivory coast": "CI", "senegal": "SN", "cameroun": "CM",
    "nigeria": "NG", "kenya": "KE", "ghana": "GH", "ethiopie": "ET", "afrique du sud": "ZA",
    "south africa": "ZA", "rdc": "CD", "drc": "CD", "congo kinshasa": "CD",
    "mexique": "MX", "mexico city": "MX", "canada": "CA", "quebec": "CA", "ontario": "CA",
    "colombie": "CO", "perou": "PE", "chili": "CL", "argentine": "AR", "uruguay": "UY",
    "venezuela": "VE", "equateur": "EC", "bolivie": "BO", "paraguay": "PY",
    "australie": "AU", "aussie": "AU", "nouvelle zelande": "NZ", "aotearoa": "NZ",
    "irlande": "IE", "islande": "IS", "roumanie": "RO", "bulgarie": "BG", "serbie": "RS",
    "croatie": "HR", "slovenie": "SI", "slovaquie": "SK", "lituanie": "LT", "lettonie": "LV",
    "estonie": "EE", "georgie": "GE", "armenie": "AM", "azerbaidjan": "AZ",
    "kazakhstan": "KZ", "ouzbekistan": "UZ", "мoсква": "RU", "москва": "RU", "россия": "RU",
    "украина": "UA", "київ": "UA", "中国": "CN", "中國": "CN", "北京": "CN", "上海": "CN",
    "深圳": "CN", "杭州": "CN", "广州": "CN", "成都": "CN", "台灣": "TW", "台湾": "TW",
    "香港": "HK", "日本": "JP", "東京": "JP", "东京": "JP", "대한민국": "KR", "한국": "KR",
    "서울": "KR", "भारत": "IN", "ประเทศไทย": "TH", "việt nam": "VN",
}

# Noms courants absents de la base ISO, et écritures locales fréquentes.
EXTRA_ALIASES.update({
    "syria": "SY", "syrie": "SY", "russia": "RU", "tanzania": "TZ", "laos": "LA",
    "bolivia": "BO", "brunei": "BN", "macedonia": "MK", "bosnia": "BA", "herzegovina": "BA",
    "cape verde": "CV", "east timor": "TL", "myanmar": "MM", "burma": "MM", "birmanie": "MM",
    "cymru": "GB", "eire": "IE", "hellas": "GR", "武汉": "CN", "湖北": "CN", "广东": "CN",
    "四川": "CN", "浙江": "CN", "江苏": "CN", "山东": "CN", "河南": "CN", "湖南": "CN",
    "福建": "CN", "安徽": "CN", "陕西": "CN", "重庆": "CN", "天津": "CN", "南京": "CN",
    "苏州": "CN", "西安": "CN", "长沙": "CN", "青岛": "CN", "大连": "CN", "沈阳": "CN",
    "厦门": "CN", "成都": "CN", "广州": "CN", "台北": "TW", "대구": "KR", "부산": "KR",
    "大阪": "JP", "京都": "JP", "横浜": "JP",
})

# Subdivisions souvent écrites sans le pays (Inde, Chine, Brésil…).
REGIONS = {
    "IN": "maharashtra, karnataka, tamil nadu, gujarat, uttar pradesh, west bengal, rajasthan, "
          "telangana, andhra pradesh, madhya pradesh, bihar, odisha, assam, haryana, punjab, "
          "jharkhand, chhattisgarh, uttarakhand, himachal pradesh, goa, delhi ncr, ncr",
    "CN": "guangdong, zhejiang, jiangsu, shandong, sichuan, hubei, hunan, henan, fujian, anhui, "
          "shaanxi, liaoning, jilin, heilongjiang, yunnan, guangxi, jiangxi, hebei, shanxi, "
          "gansu, xinjiang, inner mongolia, guizhou, ningxia, qinghai, hainan, tibet",
    "BR": "minas gerais, bahia, parana, santa catarina, rio grande do sul, pernambuco, ceara, "
          "goias, distrito federal, mato grosso, paraiba, espirito santo",
    "GB": "wales, scotland, england, northern ireland, yorkshire, kent, surrey, essex",
    "US": "new england, midwest, pacific northwest, socal, norcal, silicon valley",
    "DE": "bayern, bavaria, nrw, baden wurttemberg, sachsen, hessen, niedersachsen",
    "CA": "british columbia, alberta, saskatchewan, manitoba, nova scotia, newfoundland",
    "AU": "new south wales, queensland, western australia, tasmania",
    "ES": "andalucia, galicia, pais vasco, euskadi, catalunya",
}

# Codes d'États brésiliens : « Atibaia - SP ».
BR_STATES = "ac al ap am ba ce df es go ma mt ms mg pa pb pr pe pi rj rn ro rr rs sc se sp to"

# Villes les plus représentées chez les développeurs (séparées par des virgules).
CITIES = {
    "US": "new york, nyc, brooklyn, manhattan, san francisco, sf, bay area, palo alto, "
          "mountain view, menlo park, cupertino, sunnyvale, san jose, oakland, berkeley, "
          "los angeles, san diego, santa monica, pasadena, sacramento, irvine, seattle, "
          "redmond, bellevue, portland, denver, boulder, austin, dallas, houston, "
          "san antonio, chicago, boston, somerville, detroit, ann arbor, atlanta, miami, "
          "orlando, tampa, philadelphia, pittsburgh, washington dc, baltimore, raleigh, "
          "durham, charlotte, nashville, minneapolis, st louis, kansas city, phoenix, "
          "scottsdale, las vegas, salt lake city, columbus, cleveland, cincinnati, "
          "indianapolis, madison, new orleans, honolulu, anchorage, albuquerque, providence, "
          "hartford, richmond, tulsa, omaha, boise, dayton, reno, tucson, buffalo, rochester",
    "GB": "london, londres, manchester, birmingham, leeds, liverpool, bristol, cambridge, "
          "oxford, edinburgh, glasgow, cardiff, belfast, brighton, sheffield, nottingham, "
          "newcastle, reading, southampton, leicester, coventry, bath, york",
    "FR": "paris, lyon, marseille, toulouse, bordeaux, lille, nantes, strasbourg, montpellier, "
          "nice, rennes, grenoble, toulon, angers, dijon, nancy, reims, sophia antipolis, "
          "ile de france, saint etienne, tours, amiens, metz, brest, perpignan, besancon, "
          "orleans, mulhouse, caen, rouen, avignon, clermont ferrand, le havre, "
          "aix en provence, la rochelle, pau, annecy, chambery, limoges, poitiers, versailles, "
          "nanterre, boulogne billancourt, montreuil, vannes, lorient, bayonne, biarritz",
    "DE": "berlin, munich, munchen, hamburg, frankfurt, koln, cologne, stuttgart, dusseldorf, "
          "leipzig, dresden, hannover, nuremberg, nurnberg, karlsruhe, aachen, bonn, mannheim, "
          "heidelberg, bremen, bremerhaven, essen, dortmund, duisburg, bochum, wuppertal, "
          "bielefeld, munster, augsburg, kiel, freiburg, regensburg, jena, chemnitz, "
          "magdeburg, erfurt, potsdam, ulm, darmstadt, kassel, braunschweig, wurzburg, tubingen",
    "ES": "madrid, barcelona, valencia, sevilla, seville, bilbao, malaga, zaragoza, granada, "
          "alicante, murcia, valladolid, vigo, santander, salamanca, pamplona, san sebastian",
    "IT": "rome, roma, milan, milano, turin, torino, naples, napoli, florence, firenze, "
          "bologna, venice, venezia, genoa, pisa, palermo, trento, verona, padova, bari, "
          "catania, brescia, modena, parma, trieste, perugia, cagliari",
    "NL": "amsterdam, rotterdam, utrecht, eindhoven, the hague, den haag, delft, groningen, "
          "nijmegen, tilburg, breda, haarlem, leiden, enschede",
    "PT": "lisbon, lisboa, lisbonne, porto, braga, coimbra, aveiro, faro",
    "PL": "warsaw, warszawa, krakow, cracovie, wroclaw, poznan, gdansk, lodz, katowice, "
          "szczecin, lublin, bydgoszcz, rzeszow",
    "SE": "stockholm, gothenburg, goteborg, malmo, uppsala, lund, linkoping, umea",
    "NO": "oslo, bergen, trondheim, stavanger",
    "DK": "copenhagen, copenhague, kobenhavn, aarhus, odense, aalborg",
    "FI": "helsinki, espoo, tampere, oulu, turku, jyvaskyla",
    "IE": "dublin, cork, galway, limerick",
    "CH": "zurich, geneva, geneve, basel, bern, lausanne, lugano, zug, winterthur, st gallen",
    "AT": "vienna, wien, vienne, graz, linz, salzburg, innsbruck, klagenfurt",
    "BE": "brussels, bruxelles, antwerp, anvers, ghent, gand, leuven, liege, bruges, namur, bxl",
    "CZ": "prague, praha, brno, ostrava, plzen, olomouc",
    "GR": "athens, athenes, thessaloniki, patras, heraklion",
    "RO": "bucharest, bucarest, cluj, timisoara, iasi, brasov, sibiu, constanta",
    "HU": "budapest, debrecen, szeged, pecs",
    "BG": "sofia, plovdiv, varna, burgas",
    "RS": "belgrade, beograd, novi sad, nis",
    "HR": "zagreb, split, rijeka, osijek",
    "SI": "ljubljana, maribor",
    "SK": "bratislava, kosice",
    "LT": "vilnius, kaunas",
    "LV": "riga",
    "EE": "tallinn, tartu",
    "UA": "kyiv, kiev, kharkiv, lviv, odesa, odessa, dnipro, zaporizhzhia, vinnytsia",
    "RU": "moscow, moscou, saint petersburg, st petersburg, novosibirsk, yekaterinburg, kazan, "
          "nizhny novgorod, samara, krasnodar, tomsk, perm, ufa, voronezh",
    "BY": "minsk", "MD": "chisinau", "GE": "tbilisi", "AM": "yerevan", "AZ": "baku",
    "TR": "istanbul, ankara, izmir, bursa, antalya, konya, adana, gaziantep, kayseri, eskisehir",
    "CN": "beijing, pekin, shanghai, shenzhen, guangzhou, hangzhou, chengdu, wuhan, xian, "
          "nanjing, suzhou, tianjin, chongqing, qingdao, xiamen, dalian, shenyang, changsha, "
          "hefei, jinan, zhengzhou, kunming, fuzhou, ningbo, wuxi, dongguan, foshan, harbin",
    "JP": "tokyo, osaka, kyoto, yokohama, nagoya, fukuoka, sapporo, kobe, sendai, hiroshima, "
          "kawasaki, saitama, chiba, okinawa, nara",
    "KR": "seoul, busan, incheon, daejeon, daegu, pangyo, gwangju, ulsan, suwon, seongnam",
    "IN": "bangalore, bengaluru, mumbai, bombay, delhi, new delhi, noida, gurgaon, gurugram, "
          "hyderabad, chennai, pune, kolkata, ahmedabad, jaipur, kochi, kerala, indore, "
          "chandigarh, lucknow, nashik, vadodara, surat, nagpur, coimbatore, mysore, "
          "mangalore, bhopal, patna, kanpur, thiruvananthapuram, visakhapatnam, faridabad, "
          "ghaziabad, hoshiarpur, ludhiana, amritsar, jodhpur, udaipur, dehradun, guwahati, "
          "bhubaneswar, raipur, ranchi, vijayawada, madurai, tiruchirappalli, thane, kalyan",
    "SG": "singapore, singapour",
    "HK": "hong kong, hongkong, kowloon",
    "TW": "taipei, taichung, kaohsiung, hsinchu, tainan",
    "MY": "kuala lumpur, penang, johor, selangor, sabah, sarawak, ipoh, shah alam, kuching",
    "ID": "jakarta, bandung, surabaya, yogyakarta, bali, denpasar, medan, semarang, makassar, "
          "malang, tangerang, bekasi, depok, palembang, bogor, tanggamus",
    "TH": "bangkok, chiang mai, phuket, pattaya, khon kaen",
    "VN": "hanoi, ho chi minh, saigon, da nang, hai phong, can tho, hue",
    "PH": "manila, cebu, davao, quezon city, makati, pasig, taguig, iloilo",
    "PK": "karachi, lahore, islamabad, rawalpindi, faisalabad, peshawar, multan, quetta",
    "BD": "dhaka, chittagong, sylhet, khulna",
    "LK": "colombo, kandy", "NP": "kathmandu, pokhara", "MM": "yangon", "KH": "phnom penh",
    "MN": "ulaanbaatar", "UZ": "tashkent, samarkand", "KZ": "almaty, astana, nur sultan",
    "KG": "bishkek",
    "IL": "tel aviv, jerusalem, haifa, herzliya, ramat gan, beer sheva",
    "AE": "dubai, abu dhabi, sharjah, ajman",
    "SA": "riyadh, jeddah, dammam, mecca, medina",
    "QA": "doha", "KW": "kuwait city", "BH": "manama", "OM": "muscat", "JO": "amman",
    "LB": "beirut, beyrouth", "SY": "damascus, damas, aleppo", "YE": "sanaa",
    "IR": "tehran, teheran, isfahan, mashhad, shiraz, tabriz, karaj, qom",
    "IQ": "baghdad, erbil, basra, mosul, sulaymaniyah",
    "EG": "cairo, le caire, alexandria, giza, mansoura, tanta",
    "MA": "casablanca, rabat, marrakech, tanger, fes, agadir, meknes, oujda",
    "DZ": "alger, algiers, oran, constantine, annaba, setif, blida, tizi ouzou",
    "TN": "tunis, sfax, sousse, monastir, nabeul",
    "NG": "lagos, abuja, ibadan, port harcourt, kano, benin city, enugu",
    "KE": "nairobi, mombasa, kisumu", "GH": "accra, kumasi, tamale",
    "ZA": "johannesburg, cape town, le cap, durban, pretoria, stellenbosch, port elizabeth",
    "ET": "addis ababa", "UG": "kampala", "TZ": "dar es salaam, arusha, dodoma",
    "SN": "dakar", "CI": "abidjan, yamoussoukro", "CM": "douala, yaounde",
    "CD": "kinshasa, lubumbashi", "RW": "kigali", "ZM": "lusaka", "ZW": "harare",
    "BW": "gaborone", "MZ": "maputo", "AO": "luanda", "ML": "bamako", "BF": "ouagadougou",
    "BJ": "cotonou", "TG": "lome", "GN": "conakry", "SD": "khartoum", "SO": "mogadishu",
    "MG": "antananarivo", "MU": "port louis",
    "CA": "toronto, vancouver, montreal, ottawa, calgary, edmonton, waterloo, winnipeg, "
          "halifax, victoria, quebec city, mississauga, laval, gatineau, sherbrooke, "
          "kitchener, burnaby, richmond hill, markham",
    "MX": "guadalajara, monterrey, ciudad de mexico, cdmx, puebla, queretaro, tijuana, merida, "
          "leon, toluca, cancun",
    "BR": "sao paulo, rio de janeiro, belo horizonte, brasilia, curitiba, porto alegre, recife, "
          "fortaleza, salvador, campinas, florianopolis, manaus, goiania, belem, natal, "
          "joao pessoa, sorocaba, ribeirao preto, atibaia, niteroi, santos, uberlandia, maringa",
    "AR": "buenos aires, cordoba, rosario, mendoza, la plata, tucuman, mar del plata",
    "CL": "santiago, valparaiso, concepcion, vina del mar",
    "CO": "bogota, medellin, cali, barranquilla, bucaramanga, cartagena",
    "PE": "lima, arequipa, trujillo, cusco",
    "UY": "montevideo, tacuarembo",
    "EC": "quito, guayaquil, cuenca",
    "VE": "caracas, maracaibo",
    "BO": "la paz, santa cruz, cochabamba", "PY": "asuncion",
    "CR": "san jose costa rica, heredia", "PA": "panama city", "GT": "guatemala city",
    "CU": "havana, la havane", "DO": "santo domingo", "PR": "san juan",
    "HN": "tegucigalpa", "SV": "san salvador", "NI": "managua",
    "AU": "sydney, melbourne, brisbane, perth, adelaide, canberra, hobart, gold coast, "
          "wollongong, geelong",
    "NZ": "auckland, wellington, christchurch, dunedin",
}

US_STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
    "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia us": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york state": "NY",
    "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington state": "WA", "west virginia": "WV", "wisconsin": "WI",
    "wyoming": "WY",
}
STATE_CODES = sorted(set(US_STATES.values()))

# Codes à deux lettres que les profils utilisent réellement comme suffixe pays :
# ils l'emportent sur l'homonyme d'État américain (« Berlin, DE » = Allemagne).
STRONG_CC = ("uk gb us fr de it es br cn jp in ru nl se no dk fi pl pt tr ua ar mx kr sg hk tw "
             "id th vn ph il ae za ng eg ke ch be at cz gr ie au nz ca")


def norm(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    cleaned = "".join(c if (c.isalnum() or c.isspace()) else " " for c in stripped)
    return " ".join(cleaned.lower().split())


def main() -> None:
    entries = json.loads(ISO_JSON.read_text("utf-8"))["3166-1"]
    french = gettext.translation("iso_3166-1", "/usr/share/locale", languages=["fr"], fallback=True)

    code_to_continent = {}
    for cont, codes in CONTINENTS.items():
        for code in codes.split():
            code_to_continent[code] = cont

    countries, aliases = {}, {}
    for entry in entries:
        code = entry["alpha_2"]
        english = entry.get("common_name") or entry["name"]
        label = french.gettext(english)
        countries[code] = [label, code_to_continent.get(code, "XX")]
        for variant in {english, label, entry["name"], entry.get("official_name", "")}:
            key = norm(variant)
            if len(key) > 2:
                aliases.setdefault(key, code)

    for key, code in EXTRA_ALIASES.items():
        aliases[norm(key)] = code

    cities = {}
    for table in (CITIES, REGIONS):
        for code, blob in table.items():
            for city in blob.split(","):
                key = norm(city)
                if key:
                    cities.setdefault(key, code)

    data = {
        "countries": countries,
        "continents": CONTINENT_NAMES,
        "aliases": aliases,
        "cities": cities,
        "states": {norm(k): v for k, v in US_STATES.items()},
        "stateCodes": [c.lower() for c in STATE_CODES],
        "brStates": BR_STATES.split(),
        "strongCC": STRONG_CC.split(),
    }
    OUT.write_text(
        "/* Généré par tools/gen_geo.py — ne pas éditer à la main. */\n"
        "(typeof window !== 'undefined' ? window : globalThis).GEO_DATA = "
        + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n",
        "utf-8",
    )
    print(f"{OUT} : {len(countries)} pays, {len(aliases)} alias, {len(cities)} villes")


if __name__ == "__main__":
    main()
