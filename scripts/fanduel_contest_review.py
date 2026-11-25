#!/usr/bin/env python3
"""Post-slate FanDuel exposure audit. Never use final results as pre-lock predictions."""
import argparse,csv,json,re,collections,statistics
from pathlib import Path
P=re.compile(r'(PG|SG|SF|PF|C|QB|RB|WR|TE|D|DST)\s+(.+?)\s+\((\d+-\d+)\)(?=,\s*(?:PG|SG|SF|PF|C|QB|RB|WR|TE|D|DST)\s+|$)')
def num(s):
 try:return float(str(s).replace('$','').replace(',','').replace('%',''))
 except (ValueError,TypeError):return None
def analyze(path,username):
 entries=0;user=[];stats={};top=collections.Counter()
 with open(path,encoding='utf-8-sig',newline='') as f:
  for row in csv.DictReader(f):
   if not row.get('EntryId'):continue
   entries+=1
   name=re.sub(r'\s*\(\d+/\d+\)\s*$','',row.get('EntryName','')).strip()
   picks=[{'slot':slot,'name':player,'id':pid} for slot,player,pid in P.findall(row.get('Lineup') or '')]
   rank=int(row['Rank']) if row.get('Rank','').isdigit() else None
   if rank is not None and rank<=20:
    for p in picks:top[p['id']]+=1
   if name.casefold()==username.casefold():
    user.append({'rank':rank,'score':num(row.get('Points')),'gross_winnings':num(row.get('Won')) or 0,'picks':picks})
   m=re.match(r'(.+?)\s+\((\d+-\d+)\)',row.get('Player',''))
   if m:stats[m.group(2)]={'name':m.group(1),'actual_fpts':num(row.get('FPTS')),'salary':num(row.get('Salary')),'ownership_pct':num(row.get('%Drafted'))}
 if not user:raise ValueError('Username not found in the supplied contest.')
 exposure=collections.Counter(p['id'] for e in user for p in e['picks'])
 players=[]
 for pid,n in exposure.most_common():
  s=stats.get(pid,{})
  players.append({'name':s.get('name') or next(p['name'] for e in user for p in e['picks'] if p['id']==pid),'appearances':n,'exposure_pct':round(n*100/len(user),1),'actual_fpts':s.get('actual_fpts'),'salary':s.get('salary'),'field_ownership_pct':s.get('ownership_pct'),'top20_appearances':top[pid]})
 scores=[e['score'] for e in user if e['score'] is not None]
 return {'platform':'FanDuel','source':Path(path).name,'username':username,'contest_entries':entries,'user_entries':len(user),'mean_user_score':round(statistics.mean(scores),2) if scores else None,'gross_winnings':round(sum(e['gross_winnings'] for e in user),2),'entry_fee_verified':False,'user_lineups':sorted(user,key=lambda e:e['rank'] or 999999),'player_exposure':players,'warning':'Hindsight-only contest audit; do not use final scores, field ranks or winning rosters as pre-lock features.'}
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('csv');a.add_argument('--username',default='Stayonthesidelinez');a.add_argument('--output');v=a.parse_args();result=json.dumps(analyze(v.csv,v.username),indent=2)
 if v.output:Path(v.output).write_text(result)
 else:print(result)
