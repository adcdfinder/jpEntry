# Electron Kiosk App Spec

## 🎯 targets

Please develop an application based on Electron. Below features should be considered.

1. When the application opened, there should be an popup window to let the customer input the url.

2. after the URL inputed and the ok button clicked：

   * enter **kiosk **

3. Keyboard actions：
   * A hot key should be added. I assume the ctrl + alt + shift + h can be used to wake a popup window. The popup window can let the user choose to go the root page or the last page.
   * ctrl + alt + shift + q should be used to quit the application directly.

4. session info should be kept in case when the user go back to home and the server ask the passwd again.

5. When iframe in page dectected, one popup window should be displayed and ask user whether to jump that in a new page.

6. Usually the iframe is a windows terminal/screen of server. Please adjust the resolution according the local screen.

## 🚀 the way of start application

```bash
npm install
npm start
```

-

