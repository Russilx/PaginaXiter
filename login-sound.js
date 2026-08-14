// ============================================================
// SONIDO DE LOGIN — reproduce login-sound.mp3 (tu propio audio)
// cuando alguien inicia sesión con éxito, en cualquiera de los
// logins del sitio (tienda, diamantes, bot de tickets, bot de
// ventas).
//
// reproducirSonidoLogin() devuelve una Promise que se resuelve
// recién cuando el sonido TERMINA de sonar (evento "ended") — así,
// si el código hace `await reproducirSonidoLogin()` antes de
// redirigir a otra página, el sonido llega a escucharse completo
// aunque el usuario "se vaya" enseguida después de loguearse.
// Si por algún motivo el audio no puede reproducirse (navegador
// bloqueó el autoplay, archivo corrupto, etc), no se traba nada:
// la Promise igual se resuelve, como máximo, a los 6 segundos.
//
// Para cambiar el sonido más adelante: solo hace falta reemplazar
// el archivo login-sound.mp3 por otro (mismo nombre), no hace
// falta tocar código ni los HTML de los logins.
// ============================================================

const audioLogin = new Audio('login-sound.mp3');
audioLogin.preload = 'auto';

export function reproducirSonidoLogin(){
  return new Promise((resolve) => {
    let resuelto = false;
    function terminar(){
      if(resuelto) return;
      resuelto = true;
      audioLogin.removeEventListener('ended', terminar);
      resolve();
    }

    try{
      audioLogin.currentTime = 0;
      audioLogin.addEventListener('ended', terminar, { once: true });

      const promesa = audioLogin.play();
      if(promesa && typeof promesa.catch === 'function'){
        promesa.catch(err => {
          console.error('No se pudo reproducir el sonido de login:', err);
          terminar();
        });
      }

      // red de seguridad: si "ended" nunca dispara, no dejamos
      // colgada la redirección para siempre.
      setTimeout(terminar, 6000);
    }catch(err){
      console.error('No se pudo reproducir el sonido de login:', err);
      terminar();
    }
  });
}
