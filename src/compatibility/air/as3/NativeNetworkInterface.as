package com.freshplanet.nativeExtensions
{
   /**
    * Clean-room LocalGobe AIR compatibility stub for NativeNetworkInterface.
    */
   public class NativeNetworkInterface
   {
      private var _name:String;
      private var _displayName:String;
      private var _mtu:int;
      private var _hardwareAddress:String;
      private var _active:Boolean;

      public function NativeNetworkInterface(
         name:String = "en0",
         displayName:String = "LocalGobe",
         mtu:int = 1500,
         active:Boolean = true,
         hardwareAddress:String = "",
         addresses:Array = null
      )
      {
         super();
         _name = name;
         _displayName = displayName;
         _mtu = mtu;
         _active = active;
         _hardwareAddress = hardwareAddress;
      }

      public function get name():String { return _name; }
      public function get displayName():String { return _displayName; }
      public function get mtu():int { return _mtu; }
      public function get hardwareAddress():String { return _hardwareAddress; }
      public function get active():Boolean { return _active; }
   }
}
