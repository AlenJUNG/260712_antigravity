import json
import os
import urllib.request
import urllib.parse
from bs4 import BeautifulSoup
import time
import re

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def search_daum(query):
    try:
        url = f"https://search.daum.net/search?w=tot&q={urllib.parse.quote(query)}"
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8', errors='ignore')
            soup = BeautifulSoup(html, 'html.parser')
            snippets = []
            for tag in soup.find_all(class_=lambda x: x and 'desc' in x):
                snippets.append(tag.text.strip().lower())
            return snippets
    except Exception as e:
        return []

def clean_for_print(text):
    return ''.join(c for c in text if ord(c) < 65536)

def get_search_name(name):
    clean_name = re.sub(r'^\([^)]*\)', '', name).strip()
    if not any(clean_name.endswith(suffix) for suffix in ['자연휴양림', '휴양림', '야영장', '캠핑랜드', '휴양랜드', '문화타운', '문화촌', '레포츠파크', '힐링랜드', '쉬자파크']):
        return clean_name + "자연휴양림"
    return clean_name

def main():
    raw_path = 'data/all-forests-raw.json'
    features_path = 'data/forest-features.json'
    
    if not os.path.exists(raw_path):
        print("Error: all-forests-raw.json not found.")
        return

    with open(raw_path, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)

    unique_forests = sorted(list(set(item['insttNm'] for item in raw_data)))
    print(f"Total unique forests to analyze: {len(unique_forests)}")

    # Load existing cache if available
    features = {}
    if os.path.exists(features_path):
        try:
            with open(features_path, 'r', encoding='utf-8') as f:
                features = json.load(f)
            print(f"Loaded existing cache with {len(features)} items.")
        except Exception:
            pass

    water_keywords = ['물놀이장', '수영장', '물놀이터', '풀장', '야외수영장', '야외물놀이장', '물놀이 시설', '물놀이장도', '수영장도', '물놀이할']
    valley_keywords = ['계곡', '물가', '시냇가', '계곡물', '시원한계곡', '계곡이', '계곡물놀이', '계곡을', '계곡에']

    count = 0
    for name in unique_forests:
        # Re-scrape if it's not in features, or if both valley and water are 'X' (which was likely from failed DDG run)
        if name in features:
            feat_val = features[name]
            if feat_val.get('valley') == 'O' or feat_val.get('water') == 'O':
                # Keep it and skip scraping
                continue

        search_name = get_search_name(name)
        query = f"{search_name} 계곡 물놀이"
        
        snippets = search_daum(query)
        
        has_valley = "X"
        has_water = "X"
        
        # Analyze snippets
        for snip in snippets:
            if any(kw in snip for kw in valley_keywords):
                has_valley = "O"
            if any(kw in snip for kw in water_keywords):
                has_water = "O"
                
        features[name] = {
            "valley": has_valley,
            "water": has_water
        }
        
        count += 1
        print(clean_for_print(f"[{len(features)}/{len(unique_forests)}] {name} -> 계곡: {has_valley}, 물놀이: {has_water}"))
        
        if count % 10 == 0:
            with open(features_path, 'w', encoding='utf-8') as f:
                json.dump(features, f, indent=2, ensure_ascii=False)
            print("Cache saved.")
            
        time.sleep(0.3)

    # Final save
    with open(features_path, 'w', encoding='utf-8') as f:
        json.dump(features, f, indent=2, ensure_ascii=False)
    print("All features updated and saved to data/forest-features.json")

if __name__ == '__main__':
    main()
