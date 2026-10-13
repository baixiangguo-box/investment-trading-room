if (process.env.MARKET_LIVE === '1') {
const urls = [
 ['em','https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81&fields=f2,f3,f4,f5,f6,f8,f12,f13,f14'],
 ['em82','https://82.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81&fields=f2,f3,f4,f5,f6,f8,f12,f13,f14'],
 ['sina-count','https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a'],
 ['sina-list','https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=80&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page'],
 ['sina-bj','https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=80&sort=symbol&asc=1&node=bj_a&symbol='],
 ['qt','https://qt.gtimg.cn/q=sh600519,sh000001,sz000001,bj920001'],
 ['kline','https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,5,'],
 ['em-sector','https://79.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f2,f3,f4,f5,f6,f8,f12,f13,f14']
];
await Promise.all(urls.map(async ([label,url])=>{
 try {const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://finance.sina.com.cn/'},signal:AbortSignal.timeout(12000)});const b=await r.arrayBuffer();const text=new TextDecoder(label.startsWith('sina')||label==='qt'?'gb18030':'utf-8').decode(b);console.log(JSON.stringify({label,status:r.status,bytes:b.byteLength,head:text.slice(0,1200)}));}catch(e){console.log(JSON.stringify({label,error:e.message,cause:e.cause?.message}));}
}));
}
