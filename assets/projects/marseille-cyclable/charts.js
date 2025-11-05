let chart1 = null, chart2 = null;

function palette(){
  return {
    green: '#4caf50',
    red:   '#e53935',
    cyan:  '#00bcd4'
  };
}

function baseOpts(title){
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      title: { display: true, text: title }
    },
    scales: { y: { beginAtZero: true, grid:{color:'rgba(0,0,0,.06)'} }, x:{ grid:{display:false} } }
  };
}

function updateParkingChart(proches, eloignes){
  const ctx = document.getElementById('chartParking');
  if(!ctx) return;
  chart1 && chart1.destroy();
  const c = palette();
  chart1 = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['< 100 m', '≥ 100 m'], datasets: [{ data: [proches, eloignes], backgroundColor: [c.green, c.red] }] },
    options: { plugins: { legend:{display:true, position:'bottom'}, title:{display:true, text:'Parkings proches des pistes'} } }
  });
}

function updateLengthChart(km){
  const ctx = document.getElementById('chartLongueur');
  if(!ctx) return;
  chart2 && chart2.destroy();
  const c = palette();
  chart2 = new Chart(ctx, {
    type: 'bar',
    data: { labels: ['Total'], datasets: [{ label: 'km', data: [km], backgroundColor: c.cyan }] },
    options: baseOpts('Longueur totale du réseau (km)')
  });
}
