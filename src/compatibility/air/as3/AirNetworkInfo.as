package com.freshplanet.nativeExtensions
{
   import flash.events.EventDispatcher;

   /**
    * Clean-room LocalGobe AIR compatibility stub for AirNetworkInfo.
    * Reports an active local connection so Mogobe Android proceeds to login.
    */
   public class AirNetworkInfo extends EventDispatcher
   {
      private static var _instance:AirNetworkInfo = null;

      public function AirNetworkInfo()
      {
         super();
         _instance = this;
      }

      public static function get networkInfo():AirNetworkInfo
      {
         return _instance != null ? _instance : new AirNetworkInfo();
      }

      public function setLogging(value:Boolean):void {}

      public function isConnected():Boolean { return true; }

      public function isConnectedWithWIFI():Boolean { return true; }

      public function findInterfaces():Vector.<NativeNetworkInterface>
      {
         var list:Vector.<NativeNetworkInterface> = new Vector.<NativeNetworkInterface>();
         list.push(new NativeNetworkInterface("en0", "LocalGobe", 1500, true, "", []));
         return list;
      }
   }
}
