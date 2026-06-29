    /* ===== Hosted-mode shim: call the Apps Script API with fetch() instead of
       google.script.run. credentials:'omit' = no Google cookies = anonymous =
       works in any browser no matter how many Google accounts are signed in. ===== */
    var APPS_SCRIPT_API = 'https://script.google.com/macros/s/AKfycbxcyQfAR82lZ4ZnLIgLMlqhZpl4BFJP1UY0TcIwFKggFnJ4wg1MmzAduKAaKKWueqrV3Q/exec';
    function callApi(action, args){
      var url = APPS_SCRIPT_API + '?action=' + encodeURIComponent(action);
      if(args.length && args[0] != null) url += '&data=' + encodeURIComponent(JSON.stringify(args[0]));
      if(args.length > 1 && args[1] != null) url += '&pin=' + encodeURIComponent(args[1]);
      return fetch(url, { method:'GET', credentials:'omit' })
        .then(function(r){ return r.json(); })
        .then(function(res){ if(res && res.__error) throw new Error(res.__error); return res; });
    }
    var APP_ACTIONS=['getJobs','getReview','getCrew','getFeedInfo','scanNow','createJob','updateJob','deleteJob','dismissReview','removeReviewEmail','addReviewToJob','addCrew','removeCrew'];
    function makeRunner(){
      var onOk=null,onErr=null;
      var r={withSuccessHandler:function(f){onOk=f;return r;},withFailureHandler:function(f){onErr=f;return r;}};
      APP_ACTIONS.forEach(function(n){ r[n]=function(){ callApi(n,[].slice.call(arguments)).then(function(x){if(onOk)onOk(x);}).catch(function(e){if(onErr)onErr(e);}); return r; }; });
      return r;
    }
    var google={script:{}};
    Object.defineProperty(google.script,'run',{get:makeRunner});
