// ============================================================
// SONIDO DE LOGIN — reproduce login-sound.mp3 (tu propio audio)
// cuando alguien inicia sesión con éxito, en cualquiera de los
// logins del sitio (tienda, diamantes, bot de tickets, bot de
// ventas).
//
// Para cambiar el sonido más adelante: solo hace falta reemplazar
// el archivo login-sound.mp3 por otro (mismo nombre), no hace
// falta tocar código ni los HTML de los logins.
// ============================================================

// se crea una sola vez y se reutiliza, así el navegador no tiene
// que volver a descargar el archivo en cada login.
const audioLogin = new Audio('login-sound.mp3');
audioLogin.preload = 'auto';

export function reproducirSonidoLogin(){
  try{
    audioLogin.currentTime = 0;
    const promesa = audioLogin.play();
    // algunos navegadores devuelven una Promise que puede rechazarse
    // (ej: política de autoplay) — si pasa, no rompemos el login, el
    // usuario simplemente no escucha el sonido esa vez.
    if(promesa && typeof promesa.catch === 'function'){
      promesa.catch(err => console.error('No se pudo reproducir el sonido de login:', err));
    }
  }catch(err){
    console.error('No se pudo reproducir el sonido de login:', err);
  }
}
