# 如何使用  

在对应的nat页按下F12，在控制台复制下方代码

``` js
(() => { const url = "https://cdn.jsdelivr.net/gh/LandmineHQ/uqidc-nat-manager/main.js"; const script = document.createElement("script"); script.src = url; script.type = "text/javascript"; script.async = true; script.onerror = () => { console.error("加载脚本失败:", url); }; document.head.appendChild(script); })();
```
