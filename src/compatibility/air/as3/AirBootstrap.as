package
{
   import flash.display.Loader;
   import flash.display.MovieClip;
   import flash.events.Event;
   import flash.events.IOErrorEvent;
   import flash.filesystem.FileStream;
   import flash.net.URLRequest;
   import flash.system.ApplicationDomain;
   import flash.system.LoaderContext;

   /**
    * Clean-room LocalGobe AIR bootstrap loader.
    * Preloads AIR compatibility shims and APK-extracted ANE ActionScript libraries
    * into ApplicationDomain.currentDomain before loading the unmodified root Mogobe SWF.
    */
   public class AirBootstrap extends MovieClip
   {
      private var _queue:Array;
      private var _currentLoader:Loader;
      private var _appLoader:Loader;
      private var _origin:String = "";
      private var _rootSwf:String = "/game/MogobeTabIL.swf";

      public function AirBootstrap()
      {
         super();
         installFileStreamShims();
         addEventListener(Event.ADDED_TO_STAGE, onAdded);
      }

      private function installFileStreamShims():void
      {
         var proto:* = FileStream.prototype;
         if (proto != null)
         {
            proto.open = function(file:* = null, fileMode:String = "read"):void {};
            proto.openAsync = function(file:* = null, fileMode:String = "read"):void {};
            proto.writeBytes = function(bytes:* = null, offset:uint = 0, length:uint = 0):void {};
            proto.readBytes = function(bytes:* = null, offset:uint = 0, length:uint = 0):void {};
         }
      }

      private function onAdded(e:Event):void
      {
         removeEventListener(Event.ADDED_TO_STAGE, onAdded);
         if (loaderInfo != null && loaderInfo.parameters != null)
         {
            if (loaderInfo.parameters.origin) _origin = String(loaderInfo.parameters.origin);
            if (loaderInfo.parameters.rootSwf) _rootSwf = String(loaderInfo.parameters.rootSwf);
         }
         setupQueue();
         loadNextInQueue();
      }

      private function setupQueue():void
      {
         _queue = [
            _origin + "/runtime/air/air_network_info_shim.swf",
            _origin + "/runtime/air/stage_text_init_options_shim.swf",
            _origin + "/runtime/air/stage_text_shim.swf",
            _origin + "/game/META-INF/AIR/extensions/com.freshplanet.ane.AirDeviceId/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.freshplanet.AirAlert/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.jirbo.airadc.AirAdColony/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.supersonic.mediation/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.milkmangames.extensions.GAnalytics/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.milkmangames.extensions.GoogleServices/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.freshplanet.AirInAppPurchase/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.appsflyer.adobeair/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.vungle.extensions.Vungle/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.vungle.extensions.android.AndroidSupportLib/library.swf",
            _origin + "/game/META-INF/AIR/extensions/com.milkmangames.extensions.StoreKit/library.swf"
         ];
      }

      private function loadNextInQueue():void
      {
         if (_queue.length == 0)
         {
            loadMainApp();
            return;
         }
         var url:String = String(_queue.shift());
         _currentLoader = new Loader();
         _currentLoader.contentLoaderInfo.addEventListener(Event.COMPLETE, onLibComplete);
         _currentLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onLibError);
         var ctx:LoaderContext = new LoaderContext(false, ApplicationDomain.currentDomain);
         _currentLoader.load(new URLRequest(url), ctx);
      }

      private function onLibComplete(e:Event):void
      {
         loadNextInQueue();
      }

      private function onLibError(e:IOErrorEvent):void
      {
         trace("[LocalGobe AIR] Optional library failed to load: " + e.text);
         loadNextInQueue();
      }

      private function loadMainApp():void
      {
         _appLoader = new Loader();
         _appLoader.contentLoaderInfo.addEventListener(Event.COMPLETE, onAppComplete);
         _appLoader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, onAppError);
         var ctx:LoaderContext = new LoaderContext(false, ApplicationDomain.currentDomain);
         _appLoader.load(new URLRequest(_origin + _rootSwf), ctx);
      }

      private function onAppComplete(e:Event):void
      {
         addChild(_appLoader.content);
      }

      private function onAppError(e:IOErrorEvent):void
      {
         trace("[LocalGobe AIR] Error loading root SWF: " + e.text);
      }
   }
}
