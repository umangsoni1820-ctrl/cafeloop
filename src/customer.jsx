import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, Coffee, ExternalLink, Gift, Minus, Plus, ShieldCheck, ShoppingBag, Sparkles, X } from 'lucide-react';
import { api, customerStorageKey, money, readCustomer, saveCustomer } from './lib.js';

function CoffeeMark({ cafe, small = false }) {
  if (cafe?.logo_url) return <img className={`cafe-logo ${small?'cafe-logo-small':''}`} src={cafe.logo_url} alt={`${cafe.name} logo`} />;
  return <span className={`cafe-logo-fallback ${small?'cafe-logo-small':''}`}><Coffee size={small?16:20} /></span>;
}

function CustomerFrame({ cafe, children, compact = false }) {
  return <main className={`customer-page ${compact?'customer-page-compact':''}`} style={{ '--cafe-accent': cafe?.accent_colour || '#2146b8' }}>
    <header className="customer-header"><div className="customer-brand"><CoffeeMark cafe={cafe} small /><span>{cafe?.name || 'Your neighbourhood cafe'}</span></div><span className="customer-header-note">MADE FOR REGULARS</span></header>
    <div className="customer-content">{children}</div>
    <footer className="customer-footer"><span>Made with care by <strong>CafeLoop</strong></span><span>Good coffee, good people.</span></footer>
  </main>;
}

function PrivacyNotice({ cafeName }) {
  const [open,setOpen]=useState(false);
  return <>
    <button className="privacy-link" onClick={()=>setOpen(true)}><ShieldCheck size={14}/> Privacy notice</button>
    {open&&<div className="modal-scrim" role="presentation" onMouseDown={(event)=>event.target===event.currentTarget&&setOpen(false)}><section className="customer-modal" role="dialog" aria-modal="true" aria-labelledby="privacy-title"><button className="icon-button modal-close" onClick={()=>setOpen(false)} aria-label="Close"><X size={18}/></button><span className="modal-icon"><ShieldCheck size={20}/></span><h2 id="privacy-title">A little about your data</h2><p>{cafeName} collects your name and phone number to prepare your order and keep your stamp card on this device. Your birthday is optional and is only requested after your first visit.</p><p>Offers are sent only if you tick the separate box. You can reply <strong>STOP</strong> to stop messages at any time. The cafe controls this information. To ask for a copy or deletion, please speak with the cafe team.</p><button className="button button-primary button-full" onClick={()=>setOpen(false)}>Got it</button></section></div>}
  </>;
}

export function CustomerOrder() {
  const [params] = useSearchParams();
  const location=useLocation();
  const navigate=useNavigate();
  const slug=params.get('cafe')||'';
  const table=Math.max(1,Number(params.get('table')||1));
  const [data,setData]=useState(null);
  const [customerCard,setCustomerCard]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [cart,setCart]=useState({});
  const [details,setDetails]=useState({name:'',phone:'',marketing_consent:false,birthday_day:'',birthday_month:''});
  const [orderNote,setOrderNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [submitted,setSubmitted]=useState(false);

  useEffect(()=>{
    let active=true;
    async function load(){
      setLoading(true);setError('');
      try{
        if(!slug)throw new Error('This table link is missing its cafe details. Please scan the QR code again.');
        const menu=await api(`/api/public/${encodeURIComponent(slug)}/menu`);
        if(!active)return;setData(menu);
        const saved=readCustomer(slug);
        if(saved?.token){
          try{
            const card=await api(`/api/public/${encodeURIComponent(slug)}/card`,{headers:{'X-Cafe-Token':saved.token}});
            if(active){setCustomerCard({...card,token:saved.token});setDetails((value)=>({...value,marketing_consent:Boolean(card.customer.marketing_consent)}));}
          }catch{localStorage.removeItem(customerStorageKey(slug));}
        }
      }catch(err){if(active)setError(err.message);}
      finally{if(active)setLoading(false);}
    }
    void load();return()=>{active=false;};
  },[slug]);

  const grouped=useMemo(()=>{
    const map=new Map();
    for(const item of data?.items||[]){if(!map.has(item.category))map.set(item.category,[]);map.get(item.category).push(item);}
    return [...map.entries()];
  },[data]);
  const lines=useMemo(()=>Object.entries(cart).map(([id,line])=>({item:data?.items.find((entry)=>entry.id===id),...line})).filter((line)=>line.item),[cart,data]);
  const count=lines.reduce((sum,line)=>sum+line.quantity,0);
  const total=lines.reduce((sum,line)=>sum+line.item.price*line.quantity,0);
  const setQuantity=(item,delta)=>setCart((current)=>{const next={...current};const previous=next[item.id]||{quantity:0,note:''};const quantity=previous.quantity+delta;if(quantity<=0)delete next[item.id];else next[item.id]={...previous,quantity};return next;});
  const updateNote=(id,note)=>setCart((current)=>({...current,[id]:{...current[id],note}}));

  async function placeOrder(event){
    event.preventDefault();if(!data||!lines.length)return;
    setBusy(true);setError('');
    try{
      const saved=readCustomer(slug);
      const customer=saved?.token?{
        marketing_consent:details.marketing_consent,
        ...(details.birthday_day&&details.birthday_month?{birthday_day:Number(details.birthday_day),birthday_month:Number(details.birthday_month)}:{}),
      }:{name:details.name,phone:details.phone,marketing_consent:details.marketing_consent};
      const response=await api(`/api/public/${encodeURIComponent(slug)}/order`,{method:'POST',body:{table,customer_token:saved?.token||undefined,customer,items:lines.map(({item,quantity,note})=>({menu_item_id:item.id,quantity,note})),note:orderNote}});
      saveCustomer(slug,{token:response.customer_token,name:response.customer_name});
      navigate(`/card?cafe=${encodeURIComponent(slug)}&order=${encodeURIComponent(response.order_id)}&table=${table}`,{state:{submitted:true,amount:response.amount,currency:response.currency}});
    }catch(err){setError(err.message);}
    finally{setBusy(false);}
  }

  if(loading)return <main className="customer-page"><div className="customer-loading"><span className="loader"/><p>Opening the menu…</p></div></main>;
  if(error&&!data)return <CustomerFrame><section className="customer-error"><span className="empty-icon"><Coffee size={22}/></span><span className="eyebrow">A LITTLE MIX-UP</span><h1>We can't open this menu.</h1><p>{error}</p><a className="button button-primary" href="/owner/login">Cafe owner sign in <ArrowRight size={16}/></a></section></CustomerFrame>;
  const cafe=data.cafe;

  return <CustomerFrame cafe={cafe}>
    <div className="menu-heading"><div><span className="eyebrow">ORDER AT YOUR PACE</span><h1>Something good<br className="mobile-break"/> is brewing.</h1><p>Take a seat. We'll bring it over.</p></div><div className="table-pill"><span className="table-pill-dot"/>TABLE <strong>{table}</strong></div></div>
    {customerCard&&<div className="returning-banner"><span className="returning-mark"><Coffee size={16}/></span><div><strong>Lovely to see you again, {customerCard.customer.name.split(' ')[0]}.</strong><span>Your card has {customerCard.stamps} of {customerCard.target} stamps.</span></div><Link to={`/card?cafe=${encodeURIComponent(slug)}`}>View card <ArrowRight size={14}/></Link></div>}
    {!grouped.length?<div className="empty-state menu-empty"><span className="empty-icon"><Coffee size={22}/></span><h2>The menu is being refreshed.</h2><p>Please ask the cafe team what is available today.</p></div>:<div className="order-layout">
      <div className="menu-list">{grouped.map(([category,items])=><section className="menu-category" key={category}><div className="category-heading"><h2>{category}</h2><span>{items.length} {items.length===1?'favourite':'favourites'}</span></div><div className="menu-items">{items.map((item,index)=><article key={item.id} className="menu-item-card"><div className={`menu-item-art art-tone-${index%5}`}>{item.image_url?<img src={item.image_url} alt=""/>:<Coffee size={21} strokeWidth={1.6}/>}</div><div className="menu-item-info"><div className="menu-name-row"><h3>{item.name}</h3>{item.earns_stamp===1&&<span className="stamp-mini" title="Earns one stamp when your order is completed"><Sparkles size={12}/></span>}</div><span className="menu-item-sub">{item.earns_stamp===1?'A little closer to your next coffee':'A cafe favourite'}</span><strong>{money(item.price,cafe.currency)}</strong></div><div className="item-stepper">{cart[item.id]?<><button onClick={()=>setQuantity(item,-1)} aria-label={`Remove one ${item.name}`}><Minus size={15}/></button><span>{cart[item.id].quantity}</span><button onClick={()=>setQuantity(item,1)} aria-label={`Add one ${item.name}`}><Plus size={15}/></button></>:<button className="item-add" onClick={()=>setQuantity(item,1)} aria-label={`Add ${item.name} to order`}><Plus size={18}/></button>}</div></article>)}</div></section>)}</div>
      <aside className={`order-cart ${count?'order-cart-has-items':''}`}>
        <div className="cart-heading"><div><span className="eyebrow">YOUR TABLE {table}</span><h2>Your order <span>{count||''}</span></h2></div><ShoppingBag size={20}/></div>
        {!lines.length?<div className="cart-empty"><div className="cart-empty-cup"><Coffee size={22}/></div><p>Your first pick is<br/>just a tap away.</p></div>:<>
          <div className="cart-lines">{lines.map(({item,quantity,note})=><div className="cart-line" key={item.id}><div className="cart-line-copy"><strong>{item.name} <span>×{quantity}</span></strong><small>{money(item.price*quantity,cafe.currency)}</small><input value={note} onChange={(e)=>updateNote(item.id,e.target.value)} maxLength="180" placeholder="Add a note, e.g. oat milk" aria-label={`Note for ${item.name}`}/></div><button className="cart-remove" onClick={()=>setQuantity(item,-quantity)} aria-label={`Remove ${item.name}`}><X size={15}/></button></div>)}</div>
          <label className="cart-note-label">Anything else for the team?<textarea rows="2" maxLength="400" value={orderNote} onChange={(e)=>setOrderNote(e.target.value)} placeholder="A note for the barista…"/></label>
          <div className="cart-total"><span>Total</span><strong>{money(total,cafe.currency)}</strong></div>
          <form className="checkout-form" onSubmit={placeOrder}>
            {customerCard?<div className="known-customer"><span><CheckCircle2 size={16}/></span><div><strong>Ordering for {customerCard.customer.name}</strong><small>Your card stays on this device.</small></div></div>:<>
              <div className="checkout-form-title"><span className="eyebrow">YOUR FIRST VISIT?</span><span>We'll remember your card here.</span></div>
              <label>Your name<input required maxLength="80" value={details.name} onChange={(e)=>setDetails((v)=>({...v,name:e.target.value}))} autoComplete="name" placeholder="First and last name"/></label>
              <label>WhatsApp number<input required type="tel" value={details.phone} onChange={(e)=>setDetails((v)=>({...v,phone:e.target.value}))} autoComplete="tel" placeholder="+1 415 555 0123"/><small>Include your country code.</small></label>
            </>}
            <label className="consent-check"><input type="checkbox" checked={details.marketing_consent} onChange={(e)=>setDetails((v)=>({...v,marketing_consent:e.target.checked}))}/><span><strong>Send me cafe offers</strong><small>{customerCard?(details.marketing_consent?'Optional. You can change this or reply STOP.':'Optional. Unticked by default. Reply STOP any time.'):'Optional. Unticked by default. Reply STOP any time.'}</small></span></label>
            {customerCard&&customerCard.customer.visit_count>=1&&<details className="birthday-details"><summary>Add your birthday (optional)<ChevronDown size={14}/></summary><div className="birthday-fields"><select value={details.birthday_month} onChange={(e)=>setDetails((v)=>({...v,birthday_month:e.target.value}))} aria-label="Birthday month"><option value="">Month</option>{['January','February','March','April','May','June','July','August','September','October','November','December'].map((m,i)=><option key={m} value={i+1}>{m}</option>)}</select><select value={details.birthday_day} onChange={(e)=>setDetails((v)=>({...v,birthday_day:e.target.value}))} aria-label="Birthday day"><option value="">Day</option>{Array.from({length:31},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}</select></div><small>Day and month only. We'll ask before sending any birthday treat.</small></details>}
            {error&&<div className="inline-error" role="alert">{error}</div>}
            <button className="button button-primary button-full order-submit" disabled={busy||!lines.length}>{busy?<span className="loader loader-light"/>:<>Place order · {money(total,cafe.currency)} <ArrowRight size={16}/></>}</button>
          </form>
        </>}
        <div className="cart-loyalty"><span className="cart-loyalty-icon"><Sparkles size={15}/></span><p><strong>A little thank-you, every visit.</strong><small>Collect {cafe.stamp_target} coffee stamps, get your next one free.</small></p></div>
        <PrivacyNotice cafeName={cafe.name}/>
      </aside>
    </div>}
    <div className="mobile-cart-bar">{count>0&&<><span>{count} {count===1?'item':'items'} · <strong>{money(total,cafe.currency)}</strong></span><a href="#order-checkout" onClick={(e)=>{e.preventDefault();document.querySelector('.order-cart')?.scrollIntoView({behavior:'smooth',block:'start'});}}>Review order <ArrowRight size={16}/></a></>}</div>
  </CustomerFrame>;
}

export function CustomerCard({ showRewards = false }) {
  const [params]=useSearchParams();
  const location=useLocation();
  const slug=params.get('cafe')||'';
  const orderId=params.get('order')||'';
  const [data,setData]=useState(null);
  const [currentOrder,setCurrentOrder]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [reviewing,setReviewing]=useState(false);
  const justOrdered=Boolean(location.state?.submitted);
  useEffect(()=>{
    let alive=true;
    async function load(){
      try{
        const saved=readCustomer(slug);
        if(!saved?.token)throw new Error('This card is saved on the device you used to place your order. Scan the table QR code on that device to find it.');
        const response=await api(`/api/public/${encodeURIComponent(slug)}/card`,{headers:{'X-Cafe-Token':saved.token}});
        if(alive)setData(response);
        if(orderId){try{const order=await api(`/api/public/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}`,{headers:{'X-Cafe-Token':saved.token}});if(alive)setCurrentOrder(order);}catch{if(alive)setCurrentOrder(null);}}
      }catch(err){if(alive)setError(err.message);}
      finally{if(alive)setLoading(false);}
    }
    void load();return()=>{alive=false;};
  },[slug,orderId]);
  useEffect(()=>{
    if(!data||!orderId)return;
    const saved=readCustomer(slug);if(!saved?.token)return;
    const timer=setInterval(async()=>{
      try{
        const [card,order]=await Promise.all([
          api(`/api/public/${encodeURIComponent(slug)}/card`,{headers:{'X-Cafe-Token':saved.token}}),
          api(`/api/public/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderId)}`,{headers:{'X-Cafe-Token':saved.token}}),
        ]);
        setData(card);setCurrentOrder(order);
        if(['completed','cancelled'].includes(order.status))clearInterval(timer);
      }catch{}
    },10000);
    return()=>clearInterval(timer);
  },[data?.cafe?.slug,slug,orderId]);
  async function reviewClick(){
    if(!data)return;const popup=window.open('about:blank','_blank');if(popup)popup.opener=null;setReviewing(true);setError('');
    try{const response=await api(`/api/public/${encodeURIComponent(slug)}/reviews/click`,{method:'POST',body:{token:readCustomer(slug)?.token}});if(popup)popup.location.href=response.url;else window.location.href=response.url;}
    catch(err){popup?.close();setError(err.message);}
    finally{setReviewing(false);}
  }
  if(loading)return <main className="customer-page"><div className="customer-loading"><span className="loader"/><p>Finding your card…</p></div></main>;
  if(!data)return <CustomerFrame><section className="customer-error"><span className="empty-icon"><Coffee size={22}/></span><span className="eyebrow">YOUR LITTLE CORNER</span><h1>We couldn't find your card.</h1><p>{error}</p><Link className="button button-primary" to={`/order?cafe=${encodeURIComponent(slug)}&table=${params.get('table')||1}`}>Back to the menu <ArrowRight size={16}/></Link></section></CustomerFrame>;
  const rewards=data.rewards||[];
  return <CustomerFrame cafe={data.cafe} compact>
    <div className="card-back"><Link to={`/order?cafe=${encodeURIComponent(slug)}&table=${params.get('table')||1}`}><ArrowLeft size={15}/> Back to the menu</Link></div>
    {(justOrdered||currentOrder)&&<div className="order-confirmation"><span className="confirmation-check">{currentOrder?.status==='completed'?<Check size={18}/>:currentOrder?.status==='preparing'?<Coffee size={16}/>:currentOrder?.status==='cancelled'?<X size={16}/>:<Check size={18}/>}</span><div><strong>{currentOrder?.status==='completed'?'Your order is ready.':currentOrder?.status==='preparing'?'Your order is being made.':currentOrder?.status==='cancelled'?'Please speak to the cafe team about this order.':'Your order is with the team.'}</strong><span>{currentOrder?`Table ${currentOrder.table_number} · ${money(currentOrder.amount,currentOrder.currency)} · ${currentOrder.items.map((item)=>`${item.quantity} × ${item.name}`).join(', ')}`:location.state.amount!=null?`Order total ${money(location.state.amount,location.state.currency)} · Table ${params.get('table')||'—'}`:'Thanks for stopping by.'}</span></div><span className={`order-status-chip order-status-${currentOrder?.status||'new'}`}>{(currentOrder?.status||'new').toUpperCase()}</span></div>}
    <section className="loyalty-card-wrap"><div className="loyalty-card-top"><div><span className="eyebrow">YOUR LITTLE THANK-YOU</span><h1>Hi, {data.customer.name.split(' ')[0]}.</h1><p>Every good cup brings you closer.</p></div><span className="loyalty-bean"><Coffee size={23}/></span></div>
      <div className="stamp-track" aria-label={`${Math.min(data.stamps,data.target)} of ${data.target} stamps`}>
        {Array.from({length:data.target},(_,index)=><span key={index} className={`stamp-circle ${index<data.stamps?'stamp-filled':''} ${index===data.target-1?'stamp-goal':''}`}>{index<data.stamps?<Coffee size={15}/>:index===data.target-1?<Gift size={16}/>:<span>{String(index+1).padStart(2,'0')}</span>}</span>)}
      </div>
      <div className="stamps-caption"><span>{Math.min(data.stamps,data.target)} <strong>of {data.target}</strong> stamps</span><span>{Math.max(0,data.target-data.stamps)} more to a free coffee</span></div>
      <div className="loyalty-card-footer"><span><Sparkles size={14}/> One stamp per completed coffee order</span><Link to={`/order?cafe=${encodeURIComponent(slug)}&table=${params.get('table')||1}`}>Order again <ArrowRight size={14}/></Link></div>
    </section>
    {rewards.length>0&&<section className="customer-reward-section"><div className="reward-celebrate"><span className="reward-confetti">✳</span><span className="eyebrow">A LITTLE SOMETHING FOR YOU</span><h2>Your free coffee is ready.</h2><p>Show this code to the barista when you order.</p></div><div className="customer-coupon"><span>YOUR REWARD CODE</span><strong>{rewards[0].code}</strong><small>{rewards[0].type==='coffee'?'One free coffee, with thanks.':rewards[0].type==='birthday'?'Your birthday treat is ready.':'Your come-back treat is ready.'}</small><div className="coupon-perf"/></div><div className="reward-separate-note"><Sparkles size={15}/><span>Your reward is for your visits. Reviews are always optional.</span></div></section>}
    <section className="review-card"><div className="review-card-mark"><span>♥</span></div><div className="review-card-copy"><span className="eyebrow">A MOMENT FOR US?</span><h2>Enjoying your visit?</h2><p>An honest review helps a small cafe like {data.cafe.name} grow.</p></div><button className="button button-outline" onClick={reviewClick} disabled={!data.cafe.google_review_link||reviewing}>{reviewing?'Opening…':data.cafe.google_review_link?<>Leave a Google review <ExternalLink size={15}/></>:'Review link unavailable'}</button>{!data.cafe.google_review_link&&<small className="review-link-note">The cafe hasn't added its Google review link yet.</small>}</section>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    <div className="customer-card-bottom"><span>Thanks for being part of the neighbourhood.</span><span>Ask the cafe team to update or delete your details.</span></div><PrivacyNotice cafeName={data.cafe.name}/>
  </CustomerFrame>;
}
